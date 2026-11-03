// A stand-in for the macOS helper in tests: same JSON lines, made-up answers.
import readline from 'node:readline'

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
out({ ev: 'ready', version: 'test' })
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const c = JSON.parse(line)
  if (c.cmd === 'status') out({ id: c.id, ok: true, trusted: false, screen: false })
  else if (c.cmd === 'echo') out({ id: c.id, ok: true, args: c })
  else if (c.cmd === 'click') out({ ev: 'click', x: c.x, y: c.y }), out({ id: c.id, ok: true })
  else if (c.cmd === 'hang') {
  } else if (c.cmd === 'die') process.exit(3)
  else if (c.cmd === 'quit') out({ id: c.id, ok: true }), process.exit(0)
  else out({ id: c.id, ok: false, error: 'unknown command' })
})
