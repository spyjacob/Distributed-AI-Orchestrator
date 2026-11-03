/** History preserves configuration insertion order, including offline/removed hosts.
 * Installation timestamps are not network join order. Never sort by last contact.
 */
export function numberedMachines(history, members, values = {}) {
  return Object.values({ ...history, ...Object.fromEntries(members.map((n) => [n.id, n])) })
    .map((node, index) => ({ ...node, number: index + 1,
      name: values['machine-name:' + node.id] || node.name,
    }));
}
