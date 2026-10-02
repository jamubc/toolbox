import type { Reach, Tools } from './contract'

// A provider's tools, limited to the reach its spec declares: its own
// commands, its own hosts over https, its own helper. Anything else is refused.
export function fence(reach: Reach, raw: Tools): Tools {
  const commands = reach.commands ?? []
  const hosts = reach.hosts ?? []
  const helper = reach.helper

  return {
    run: argv =>
      argv[0] !== undefined && commands.includes(argv[0])
        ? raw.run(argv)
        : Promise.reject(new Error(`refused to run ${argv[0] ?? 'nothing'}`)),

    fetch: (url, init) => {
      let target: URL | undefined
      try {
        target = new URL(url)
      } catch {
        target = undefined
      }

      return target && target.protocol === 'https:' && hosts.includes(target.hostname)
        ? raw.fetch(url, init)
        : Promise.reject(new Error(`refused to fetch ${target?.hostname ?? url}`))
    },

    spawn: argv => {
      if (!helper || argv.length !== helper.length || argv.some((one, i) => one !== helper[i])) {
        throw new Error(`refused to spawn ${argv[0] ?? 'nothing'}`)
      }

      return raw.spawn(argv)
    },
  }
}
