import type { ComfyWorkflowResource as Workflow } from '../../../pi-im-bot/src/plugins/sdk/index'
export type Path = Array<string | number>
export function parameterWriter(parameters: Workflow['parameters']) {
  function scalar(
    name: string,
    paths: Path[],
    value: string | number | boolean,
    options: Partial<Workflow['parameters'][string]> = {}
  ) {
    let type: 'string' | 'number' | 'boolean' = 'string'
    if (typeof value === 'number') {
      type = 'number'
    }
    if (typeof value === 'boolean') {
      type = 'boolean'
    }
    parameters[name] = {
      type,
      paths,
      default: value,
      min: undefined,
      max: undefined,
      maxLength: 16000,
      encoding: 'identity',
      integer: false,
      offsets: [],
      ...options
    }
  }
  return scalar
}
export type Scalar = ReturnType<typeof parameterWriter>
