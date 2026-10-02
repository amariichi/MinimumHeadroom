// Generic fullscreen terminal fixture: stdout and standard mouse reports only.
let first = 200;
process.stdin.setRawMode(true);
function render() {
  process.stdout.write('\x1b[H\x1b[2JFixed terminal header');
  for (let row = 1; row < 6; row++) process.stdout.write(`\x1b[${row + 1};1HOutput line ${first + row - 1}`);
}
process.stdout.write('\x1b[?1049h\x1b[?1003h\x1b[?1006h');
render();
process.stdin.on('data', data => {
  if (data.toString() === 'disable-mouse') {
    process.stdout.write('\x1b[?1003l');
    return;
  }
  for (const match of data.toString().matchAll(/\x1b\[<(64|65);(\d+);(\d+)M/g)) {
    first = Math.max(1, Math.min(200, first + (match[1] === '64' ? -1 : 1)));
    process.stdout.write(`\x1b]2;Mouse column ${match[2]} row ${match[3]}\x07`);
  }
  render();
});
