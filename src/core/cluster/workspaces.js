/** Where a non-project session's files are when it runs on the main.
 * The harness uses each host's own checkout. Project sessions run from their
 * app's copy on this machine (placement.js); a loose session's folder is not
 * copied between machines, so it runs only on the host that made it.
 */
import { HARNESS_ROOT, HARNESS_APP_ID } from '../harness-guard.js';
export function portableWorkspaces(cluster) {
  return {
    async prepare(session) {
      if (session.appId === HARNESS_APP_ID || session.editsHarness) { session.projectDir = HARNESS_ROOT; session.ownerNode = cluster.self.id; return; }
      if (!session.ownerNode || session.ownerNode === cluster.self.id) return;
      const host = cluster.replica.state.history[session.ownerNode]?.name || 'another machine';
      throw new Error(`This tab's folder is on ${host} and is not copied between machines. Make ${host} main to continue it, or work in a project and choose its machines.`);
    },
  };
}
