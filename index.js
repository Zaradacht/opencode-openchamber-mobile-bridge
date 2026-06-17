export const id = "opencode-openchamber-mobile-bridge";

export async function server() {
  return {
    event: async () => {
      // Runtime access is managed by the companion CLI. The plugin entrypoint is
      // intentionally minimal so OpenCode can load the package as a server
      // plugin without requiring host permissions from inside the agent runtime.
    },
  };
}

export default {
  id,
  server,
};
