import { expect, test } from 'bun:test'
import { parseDraw } from '../plugins/comfyui-pro/src/commands'
import { parameters } from '../plugins/comfyui-pro/src/parameters'
import { DrawSchema, SettingsSchema } from '../plugins/comfyui-pro/src/settings'
import { WorkflowSchema, type Workflow } from '../plugins/comfyui-pro/src/catalog'
function workflow(): Workflow {
  return WorkflowSchema.parse({
    id: 'fixture',
    name: 'Fixture',
    description: 'Authored',
    digest: 'hash',
    models: [],
    bindings: {
      positive: 'positive',
      negative: 'negative',
      seed: 'seed',
      stepNodes: { '11': 'steps11', '22': 'steps22' },
      loras: [
        { name: 'lora0', strength: 'weight0' },
        { name: 'lora1', strength: 'weight1' }
      ]
    },
    parameters: {
      positive: { type: 'string', default: 'old', maxLength: 8000 },
      negative: { type: 'string', default: 'base negative', maxLength: 8000 },
      seed: { type: 'number', maxLength: 100 },
      steps11: { type: 'number', default: 12, min: 1, max: 50, maxLength: 100 },
      steps22: { type: 'number', default: 20, min: 1, max: 100, maxLength: 100 },
      lora0: { type: 'string', default: 'default.safetensors', maxLength: 300 },
      weight0: { type: 'number', default: 0.7, maxLength: 300 },
      lora1: { type: 'string', default: '', maxLength: 300 },
      weight1: { type: 'number', default: 0, maxLength: 300 }
    },
    loras: [
      {
        id: 'default',
        name: 'default',
        filename: 'default.safetensors',
        enabled: true,
        triggers: [],
        strength: 0.7
      },
      {
        id: 'selected',
        name: 'selected',
        filename: 'selected.safetensors',
        enabled: true,
        triggers: ['option one', 'option two'],
        strength: 1
      }
    ]
  })
}
function active(wf: Workflow, values: Record<string, string | number | boolean>) {
  return wf.bindings.loras
    .filter((slot) => {
      return (values[slot.strength] ?? wf.parameters[slot.strength].default) !== 0
    })
    .map((slot) => {
      return values[slot.name] ?? wf.parameters[slot.name].default
    })
}
test('negative aliases never increase GPU count; quoting preserves option-looking negative text', () => {
  for (const flag of ['-n', '--neg', '--negative']) {
    expect(DrawSchema.parse(parseDraw('a cat ' + flag + ' 2', true))).toMatchObject({
      count: 1,
      negative_prompt: '2'
    })
  }
  expect(parseDraw('a cat -n "--count 16 lowres" -c 2 -wf custom', false)).toEqual({
    prompt: 'a cat',
    negative_prompt: '--count 16 lowres',
    count: 2,
    workflow: 'custom',
    direct_send: false
  })
  expect(parseDraw('"a --count cat" --count 1 --negative bad -- --workflow literal', true)).toMatchObject({
    prompt: 'a --count cat',
    count: 1,
    negative_prompt: 'bad --workflow literal'
  })
  for (const text of [
    'cat -n',
    'cat -c 0',
    'cat --count abc',
    'cat --unknown 1',
    'cat --count 1 -c 2',
    'cat -n "broken'
  ]) {
    expect(() => {
      parseDraw(text, true)
    }).toThrow()
  }
})
test('keep-defaults allocates unused LoRA slots, detects capacity and deduplicates names', () => {
  const wf = workflow()
  const args = DrawSchema.parse({
    prompt: 'cat',
    loras: [{ name: 'selected' }, { name: 'selected.safetensors' }]
  })
  const values = parameters(wf, args, SettingsSchema.parse({ keep_defaults_when_selected: true }), 42)
  expect(active(wf, values)).toEqual(['default.safetensors', 'selected.safetensors'])
  const full = workflow()
  full.parameters.lora1.default = 'another.safetensors'
  full.parameters.weight1.default = 0.5
  expect(() => {
    parameters(full, args, SettingsSchema.parse({}), 42)
  }).toThrow('足够')
  const same = parameters(
    wf,
    DrawSchema.parse({ prompt: 'cat', loras: [{ name: 'default' }] }),
    SettingsSchema.parse({}),
    42
  )
  expect(active(wf, same)).toEqual(['default.safetensors'])
})
test('clear/no-keep/disabled defaults are separate choices and selection limits do not silently drop defaults', () => {
  const wf = workflow()
  const args = DrawSchema.parse({ prompt: 'cat', loras: [{ name: 'selected' }] })
  expect(active(wf, parameters(wf, { ...args, clear_defaults: true }, SettingsSchema.parse({}), 42))).toEqual(
    ['selected.safetensors']
  )
  expect(
    active(wf, parameters(wf, args, SettingsSchema.parse({ keep_defaults_when_selected: false }), 42))
  ).toEqual(['selected.safetensors'])
  wf.loras[0].enabled = false
  expect(active(wf, parameters(wf, args, SettingsSchema.parse({}), 42))).toEqual(['selected.safetensors'])
  expect(() => {
    parameters(
      wf,
      DrawSchema.parse({ prompt: 'cat', loras: [{ name: 'default' }] }),
      SettingsSchema.parse({}),
      42
    )
  }).toThrow('禁用')
  expect(() => {
    parameters(wf, args, SettingsSchema.parse({ max_loras: 0 }), 42)
  }).toThrow('数量')
})
test('trigger injection uses explicit choices, configured hints or a sole candidate, never guesses multiple candidates', () => {
  const wf = workflow()
  const args = DrawSchema.parse({ prompt: 'cat', loras: [{ name: 'selected' }] })
  expect(parameters(wf, args, SettingsSchema.parse({}), 42).positive).toBe('cat')
  expect(
    parameters(wf, { ...args, loras: [{ name: 'selected', triggers: [1, 2] }] }, SettingsSchema.parse({}), 42)
      .positive
  ).toBe('option one, option two, cat')
  wf.loras[1].promptHints = ['default hint']
  expect(parameters(wf, args, SettingsSchema.parse({}), 42).positive).toBe('default hint, cat')
  wf.loras[1].promptHints = []
  wf.loras[1].triggers = ['unique']
  expect(parameters(wf, args, SettingsSchema.parse({}), 42).positive).toBe('unique, cat')
  expect(
    parameters(
      wf,
      { ...args, loras: [{ name: 'selected', triggers: [1] }] },
      SettingsSchema.parse({ inject_selected_prompt_hints: false }),
      42
    ).positive
  ).toBe('cat')
})
test('workflow-scoped steps compile only declared parameters with explicit request precedence', () => {
  const wf = workflow()
  const args = DrawSchema.parse({ prompt: 'cat', steps: 25, node_steps: { '22': 30 } })
  const values = parameters(wf, args, SettingsSchema.parse({}), 42, { '11': 15 })
  expect(values.steps11).toBe(25)
  expect(values.steps22).toBe(30)
  expect(values.negative).toBe('base negative')
  expect(() => {
    parameters(wf, args, SettingsSchema.parse({}), 42, { '999': 10 })
  }).toThrow('未登记')
  expect(() => {
    parameters(wf, { ...args, node_steps: { '11': 60 } }, SettingsSchema.parse({}), 42)
  }).toThrow('范围')
})
