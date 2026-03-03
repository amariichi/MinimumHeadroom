import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeOperatorAsrTerms } from '../../face-app/public/operator_asr_term_normalizer.js';

test('operator ASR term normalizer rewrites common Japanese phonetic spellings', () => {
  assert.equal(normalizeOperatorAsrTerms('きっとハブにプッシュしてください。', 'ja'), 'GitHubにpushしてください。');
  assert.equal(normalizeOperatorAsrTerms('ギフトハブにプッシュしてください。', 'ja'), 'GitHubにpushしてください。');
  assert.equal(normalizeOperatorAsrTerms('きっと肌にプッシュしてください。', 'ja'), 'GitHubにpushしてください。');
  assert.equal(normalizeOperatorAsrTerms('ヒットハガにプッシュしてください。', 'ja'), 'GitHubにpushしてください。');
  assert.equal(normalizeOperatorAsrTerms('ヒットハブにプッシュしてください。', 'ja'), 'GitHubにpushしてください。');
  assert.equal(normalizeOperatorAsrTerms('ヒットハグにプッシュしてください。', 'ja'), 'GitHubにpushしてください。');
  assert.equal(normalizeOperatorAsrTerms('じゃばすくりぷとでえーぴーあいをたたきます。', 'ja'), 'JavaScriptでAPIをたたきます。');
  assert.equal(normalizeOperatorAsrTerms('ノードJSでえーぴーあいとえいちてぃーてぃーぴーを確認します。', 'ja'), 'Node.jsでAPIとHTTPを確認します。');
  assert.equal(normalizeOperatorAsrTerms('ロードJSでAPIとHTTPを確認します。', 'ja'), 'Node.jsでAPIとHTTPを確認します。');
  assert.equal(normalizeOperatorAsrTerms('ノードセンスでAPIとHTTPを確認します。', 'ja'), 'Node.jsでAPIとHTTPを確認します。');
  assert.equal(normalizeOperatorAsrTerms('喉J.S.でAPIとHTTPを確認します。', 'ja'), 'Node.jsでAPIとHTTPを確認します。');
  assert.equal(normalizeOperatorAsrTerms('ノードJSでAPIとHTTPU確認します。', 'ja'), 'Node.jsでAPIとHTTPを確認します。');
  assert.equal(normalizeOperatorAsrTerms('ぷるりくをまーじしてぶらんちを確認します。', 'ja'), 'pull requestをmergeしてbranchを確認します。');
  assert.equal(normalizeOperatorAsrTerms('プロリクエストを確認します。', 'ja'), 'pull requestを確認します。');
  assert.equal(normalizeOperatorAsrTerms('プールリクエストを出します。', 'ja'), 'pull requestを出します。');
  assert.equal(normalizeOperatorAsrTerms('ブルーリックを見ます。', 'ja'), 'pull requestを見ます。');
  assert.equal(normalizeOperatorAsrTerms('ぐるりくを作ります。', 'ja'), 'pull requestを作ります。');
  assert.equal(normalizeOperatorAsrTerms('ピーアールを出してシーアイが落ちたのでシーディーは止めます。', 'ja'), 'PRを出してCIが落ちたのでCDは止めます。');
  assert.equal(normalizeOperatorAsrTerms('prを出して、試合が通ったらcdします。', 'ja'), 'prを出して、CIが通ったらcdします。');
  assert.equal(normalizeOperatorAsrTerms('PRを出してCIが飛んだらCDします。', 'ja'), 'PRを出してCIが通ったらCDします。');
  assert.equal(normalizeOperatorAsrTerms('リアルを出してCIが通ったらCGします。', 'ja'), 'PRを出してCIが通ったらCDします。');
  assert.equal(normalizeOperatorAsrTerms('PRを出してCIがどうしたらCDします。', 'ja'), 'PRを出してCIが通ったらCDします。');
  assert.equal(normalizeOperatorAsrTerms('PRを出してCIが問屋新CDします。', 'ja'), 'PRを出してCIが通ったらCDします。');
  assert.equal(normalizeOperatorAsrTerms('はいソニー新生をお願いします。', 'ja'), 'はい承認申請をお願いします。');
  assert.equal(normalizeOperatorAsrTerms('はい、小児先生お願いします。', 'ja'), 'はい、承認申請をお願いします。');
  assert.equal(normalizeOperatorAsrTerms('ずっとハブ 地銀申請をお願いします。', 'ja'), 'GitHub 承認申請をお願いします。');
  assert.equal(normalizeOperatorAsrTerms('SC1でCLIからJSON?とやめるを見てGPUとCPUを確認します。', 'ja'), 'SSHでCLIからJSONとYAMLを見てGPUとCPUを確認します。');
  assert.equal(normalizeOperatorAsrTerms('CIAからSSHでJSONとYAMLを見てGPUとCPUを確認します。', 'ja'), 'CLIからSSHでJSONとYAMLを見てGPUとCPUを確認します。');
  assert.equal(normalizeOperatorAsrTerms('CLYカラーSSHでJSONとYAMLを見てGPUとCPUを確認します。', 'ja'), 'CLIからSSHでJSONとYAMLを見てGPUとCPUを確認します。');
  assert.equal(normalizeOperatorAsrTerms('CNIからSSHでJSYONとヤグルを見てGPUとCPUを確認します。', 'ja'), 'CLIからSSHでJSONとYAMLを見てGPUとCPUを確認します。');
  assert.equal(normalizeOperatorAsrTerms('CNIからSS1でJSONとヤムルを見てGPUとCPUを確認します。', 'ja'), 'CLIからSSHでJSONとYAMLを見てGPUとCPUを確認します。');
  assert.equal(normalizeOperatorAsrTerms('白いからSSHでJSONとやぶりを見てGPUとCPUを確認します。', 'ja'), 'CLIからSSHでJSONとYAMLを見てGPUとCPUを確認します。');
  assert.equal(normalizeOperatorAsrTerms('CLIからSSHでJSONとヤムロを見てGPUとCPUを確認します。', 'ja'), 'CLIからSSHでJSONとYAMLを見てGPUとCPUを確認します。');
  assert.equal(normalizeOperatorAsrTerms('CPUとCPUを確認します。', 'ja'), 'GPUとCPUを確認します。');
  assert.equal(normalizeOperatorAsrTerms('TBAとCPUを確認します。', 'ja'), 'GPUとCPUを確認します。');
  assert.equal(normalizeOperatorAsrTerms('うわcpuとcpuを確認します。', 'ja'), 'GPUとCPUを確認します。');
  assert.equal(normalizeOperatorAsrTerms('エスエスエイチでシーエルアイからジェイエスオーエヌとヤムルを見て、ジーピーユーとシーピーユーを確認します。', 'ja'), 'SSHでCLIからJSONとYAMLを見て、GPUとCPUを確認します。');
});

test('operator ASR term normalizer canonicalizes lower-case ascii terms for PTT JA', () => {
  assert.equal(normalizeOperatorAsrTerms('github api url https', 'ja'), 'GitHub API URL HTTPS');
  assert.equal(normalizeOperatorAsrTerms('node jsとdockerとtmux', 'ja'), 'Node.jsとDockerとtmux');
  assert.equal(normalizeOperatorAsrTerms('jfnとyamlを確認します', 'ja'), 'JSONとYAMLを確認します');
  assert.equal(normalizeOperatorAsrTerms('js-onとyamlを確認します', 'ja'), 'JSONとYAMLを確認します');
  assert.equal(normalizeOperatorAsrTerms('cliでjsyonを見ます', 'ja'), 'CLIでJSONを見ます');
  assert.equal(normalizeOperatorAsrTerms('ap8とhttppを確認します', 'ja'), 'APIとHTTPを確認します');
  assert.equal(normalizeOperatorAsrTerms('全SONとヤムルを確認します', 'ja'), 'JSONとYAMLを確認します');
  assert.equal(normalizeOperatorAsrTerms('ジーンスONとヤムロを確認します', 'ja'), 'JSONとYAMLを確認します');
  assert.equal(normalizeOperatorAsrTerms('httppを確認します', 'ja'), 'HTTPを確認します');
});

test('operator ASR term normalizer avoids obvious false positives and non-ja rewrites', () => {
  assert.equal(normalizeOperatorAsrTerms('プッシュアップをします。', 'ja'), 'プッシュアップをします。');
  assert.equal(normalizeOperatorAsrTerms('ピーアール動画を見ます。', 'ja'), 'ピーアール動画を見ます。');
  assert.equal(normalizeOperatorAsrTerms('普通の日本語だけです。', 'ja'), '普通の日本語だけです。');
  assert.equal(normalizeOperatorAsrTerms('githubにpushしてください', 'en'), 'githubにpushしてください');
});
