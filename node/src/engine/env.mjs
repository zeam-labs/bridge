const NEW = 'BRIDGE_'
const OLD = 'PASS_'
export const SHARED_WITH_PASS_CLIENT = ['NAME', 'STATE_DIR']
export const warned = new Set()

export function setting(name, env = process.env, say = (line) => console.error(line)) {
  if (!String(name).startsWith(NEW)) throw new TypeError(`bridge: a setting is named ${NEW}…; got ${name}`)
  if (env[name]) return env[name]
  const key = name.slice(NEW.length)
  const old = env[OLD + key]
  if (!old) return undefined
  if (SHARED_WITH_PASS_CLIENT.includes(key) && !warned.has(key)) {
    warned.add(key)
    say(`bridge: ${name} is not set, so ${OLD}${key} is used; the Pass client reads ${OLD}${key} too. Set ${name}.`)
  }
  return old
}
