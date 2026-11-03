// Writes storyboard.schema.json so editors and AI tools can validate storyboards without our code.
import { writeFileSync } from 'node:fs'
import * as z from 'zod'
import { Storyboard } from '../src/storyboard.ts'

const schema = z.toJSONSchema(Storyboard, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' })
const out = {
  $id: 'urn:cuelight:storyboard:1',
  title: 'Cuelight storyboard',
  ...schema,
}
writeFileSync(new URL('../storyboard.schema.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
console.log('wrote storyboard.schema.json')
