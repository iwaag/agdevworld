// What a workflow's author expects of a node's result (improve_wfnode p1,
// docs/contract.md *Expectations*), and how a result is said to meet it.
// Shared by the service, the CLI and the browser; it touches no files. A key
// states an intent: it provisions nothing, proves nothing and permits nothing.
// Hosts, credentials and storage endpoints remain environment facts.
export const EXPECTATION_STRENGTHS = ['preferred', 'required'] as const
export type ExpectationStrength = typeof EXPECTATION_STRENGTHS[number]
export const STRENGTH_MEANING: Record<ExpectationStrength, string> = {
  preferred: 'Prioritize this; when you choose differently, say so and report what you actually delivered.',
  required: 'A condition of a satisfactory result: when it is not met it stays visible as unmet, even after the available work is finished.',
}
export interface ExpectationKey { label: string; about: 'use' | 'audience' | 'delivery'; meaning: string }
// The documented keys. `about` separates how the result is used, who receives
// it and how it travels; entries are cumulative, so browser and native can
// both be asked for. Changing a meaning changes the compiler version: a run
// keeps the words it was created with (shared/compile.ts).
export const EXPECTATION_KEYS: Record<string, ExpectationKey> = {
  webbrowser: { label: 'Browser', about: 'use', meaning: 'The person can open and check the result in a web browser.' },
  native: { label: 'Native', about: 'use', meaning: 'The person can launch and try the result natively on their review PC, which is not implied to be the machine executing this run.' },
  project: { label: 'Project', about: 'audience', meaning: 'The result is shared with another project, in a form that project can use.' },
  human: { label: 'Human', about: 'audience', meaning: 'The result is shared with a person, in a form they can receive and read.' },
  nfs: { label: 'NFS', about: 'delivery', meaning: 'The result is delivered through an NFS share.' },
  s3: { label: 'S3', about: 'delivery', meaning: 'The result is delivered through S3-compatible storage such as MinIO.' },
}
export const expectationLabel = (key: string) => EXPECTATION_KEYS[key]?.label ?? key
export const strengthOf = (x: { strength?: string }): string => x.strength ?? 'preferred'
