#!/usr/bin/env python3
"""Read-only allowance observation; never creates/resumes threads or model turns."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import queue
import sqlite3
import subprocess
import threading
import time

ALLOWED = {'initialize', 'account/read', 'account/rateLimits/read', 'config/read'}
BASE = Path(__file__).resolve().parents[1]
PRIVATE = BASE / '.agent/local/codex-usage-check'
HOME = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat()


class Reader:
    def __init__(self):
        self.proc = subprocess.Popen(['codex', 'app-server', '--stdio'], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.messages = queue.Queue()
        self.seq = 0
        def read():
            for line in self.proc.stdout:
                try:
                    self.messages.put(json.loads(line))
                except ValueError:
                    pass
        threading.Thread(target=read, daemon=True).start()
        try:
            self.call('initialize', {'clientInfo': {'name': 'local_usage_observer', 'version': '1.0'}})
        except BaseException:
            self.close()
            raise
        self.proc.stdin.write(json.dumps({'method': 'initialized'}) + '\n')
        self.proc.stdin.flush()

    def call(self, method, params=None):
        if method not in ALLOWED:
            raise ValueError('Non-read-only method prohibited')
        self.seq += 1
        self.proc.stdin.write(json.dumps({'id': self.seq, 'method': method, 'params': params or {}}) + '\n')
        self.proc.stdin.flush()
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            try:
                msg = self.messages.get(timeout=max(.01, deadline - time.monotonic()))
            except queue.Empty:
                break
            if msg.get('id') == self.seq:
                if 'error' in msg:
                    raise RuntimeError('Read-only RPC error code ' + str(msg['error'].get('code')))
                return msg.get('result', {})
        raise TimeoutError('Read-only RPC timed out')

    def close(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()


def safe_limits(result):
    bucket = result.get('rateLimits') or {}
    out = {}
    for name in ('primary', 'secondary'):
        v = bucket.get(name)
        out[name] = ({k: v.get(k) for k in ('usedPercent', 'windowDurationMins', 'resetsAt')}
                     if isinstance(v, dict) else None)
    c = bucket.get('credits')
    out['credits'] = ({k: c.get(k) for k in ('hasCredits', 'unlimited', 'balance')}
                      if isinstance(c, dict) else None)
    out['planType'] = bucket.get('planType')
    return out


def delta(first, last):
    out = {}
    for name in ('primary', 'secondary'):
        a, b = first.get(name), last.get(name)
        if not a or not b:
            out[name] = {'status': 'unknown'}
        elif a.get('resetsAt') != b.get('resetsAt') or a.get('windowDurationMins') != b.get('windowDurationMins'):
            out[name] = {'status': 'window_changed_not_comparable'}
        elif isinstance(a.get('usedPercent'), (int, float)) and isinstance(b.get('usedPercent'), (int, float)):
            out[name] = {'status': 'same_window', 'used_percentage_points': b['usedPercent'] - a['usedPercent']}
        else:
            out[name] = {'status': 'unknown'}
    return out


class Tail:
    def __init__(self, path):
        self.path = Path(path)
        self.offset = self.path.stat().st_size
        self.pending = b''
        self.ids = set()

    def poll(self):
        counts = {'response_usage_records': 0, 'task_starts': 0, 'cancellations': 0, 'log_resets': 0}
        if not self.path.exists():
            return dict(counts, missing_log=1)
        if self.path.stat().st_size < self.offset:
            counts['log_resets'] += 1
            self.offset = 0
            self.pending = b''
        with self.path.open('rb') as f:
            f.seek(self.offset)
            data = self.pending + f.read()
            self.offset = f.tell()
        lines = data.split(b'\n')
        self.pending = lines.pop()
        for line in lines:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            p = record.get('payload', {})
            if record.get('type') == 'token_usage_record':
                rid = p.get('response_id')
                if not rid or rid not in self.ids:
                    counts['response_usage_records'] += 1
                if rid:
                    self.ids.add(rid)
            elif record.get('type') == 'event_msg':
                if p.get('type') == 'task_started':
                    counts['task_starts'] += 1
                if p.get('type') == 'turn_aborted':
                    counts['cancellations'] += 1
        return counts


def save(path, result):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    temp.chmod(0o600)
    temp.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--minutes', type=float, default=75)
    parser.add_argument('--confirm-idle', action='store_true', help='All known model tasks have finished; no other device is intentionally using the account.')
    parser.add_argument('--probe', action='store_true', help='One read-only account/config/allowance check; no observation.')
    args = parser.parse_args()
    if not args.probe and (not args.confirm_idle or args.minutes < 75):
        parser.error('Observation requires --confirm-idle and at least 75 minutes')
    reader = None
    result = {'status': 'NOT RUN', 'started_utc': utc(), 'actual_duration_seconds': 0,
              'coverage': 'App-server allowance read plus appended records of five selected local tasks; new local-thread metadata. Other clients/devices and in-flight requests without records are unobserved.',
              'model_calls_by_sampler': 0, 'samples': []}
    dest = PRIVATE / ('probe.json' if args.probe else 'idle-observation-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.json')
    start = time.monotonic()
    try:
        reader = Reader()
        account = reader.call('account/read', {'refreshToken': False}).get('account') or {}
        result['account'] = {k: account.get(k) for k in ('type', 'planType')}
        if args.probe:
            config = reader.call('config/read', {'cwd': str(BASE), 'includeLayers': False}).get('config', {})
            result['config'] = {k: config.get(k) for k in ('model', 'model_reasoning_effort', 'service_tier', 'model_context_window', 'model_auto_compact_token_limit')}
            result['limits'] = safe_limits(reader.call('account/rateLimits/read'))
            result['status'] = 'PROBE_COMPLETED'
        else:
            selected = json.loads((PRIVATE / 'selected-tasks.json').read_text())
            tails = [Tail(t['rollout_path']) for t in selected]
            db = sqlite3.connect('file:' + str(HOME / 'state_5.sqlite') + '?mode=ro', uri=True)
            baseline = db.execute('select coalesce(max(created_at_ms),0) from threads').fetchone()[0]
            result['status'] = 'RUNNING'
            end = time.monotonic() + args.minutes * 60
            while True:
                sample = {'utc': utc(), 'local': [tail.poll() for tail in tails]}
                try:
                    sample['limits'] = safe_limits(reader.call('account/rateLimits/read'))
                except Exception as e:
                    sample['telemetry_error'] = type(e).__name__
                sample['new_local_threads'] = db.execute('select count(*) from threads where created_at_ms > ?', (baseline,)).fetchone()[0]
                result['samples'].append(sample)
                result['actual_duration_seconds'] = round(time.monotonic() - start, 1)
                save(dest, result)
                if time.monotonic() >= end:
                    break
                time.sleep(min(60, max(0, end - time.monotonic())))
            good = [s['limits'] for s in result['samples'] if 'limits' in s]
            result['allowance_change'] = delta(good[0], good[-1]) if len(good) > 1 else {'status': 'unknown'}
            result['interference_detected'] = any(s['new_local_threads'] or any(t.get('response_usage_records') or t.get('task_starts') for t in s['local']) for s in result['samples'])
            result['status'] = 'COMPLETED'
            db.close()
    except KeyboardInterrupt:
        result['status'] = 'INTERRUPTED'
    except Exception as e:
        result['status'] = 'FAILED'
        result['error_type'] = type(e).__name__
    finally:
        if reader:
            reader.close()
        result['actual_duration_seconds'] = round(time.monotonic() - start, 1)
        result['finished_utc'] = utc()
        save(dest, result)
    print(json.dumps(result if args.probe else {k: v for k, v in result.items() if k != 'samples'}, ensure_ascii=False))
    return 1 if result['status'] == 'FAILED' else 0


if __name__ == '__main__':
    raise SystemExit(main())
