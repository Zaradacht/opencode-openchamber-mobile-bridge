#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_CONTAINER_PORT = 3000;
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "openchamber-mobile-bridge.json");

function usage() {
  console.log(`Usage:
  opencode-openchamber-mobile-bridge start <name> [--workspace <path>] [--host-port <port>] [--no-build]
  opencode-openchamber-mobile-bridge stop <name|all>
  opencode-openchamber-mobile-bridge list
  opencode-openchamber-mobile-bridge status [name|all]

Config defaults to ~/.config/opencode/openchamber-mobile-bridge.json.
Set OPENCODE_OPENCHAMBER_MOBILE_BRIDGE_CONFIG to override it.`);
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function exec(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function commandExists(command) {
  try {
    await exec("sh", ["-lc", `command -v ${shellQuote(command)}`]);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function sanitizeName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

async function fileExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function loadConfig() {
  const configPath = process.env.OPENCODE_OPENCHAMBER_MOBILE_BRIDGE_CONFIG || DEFAULT_CONFIG_PATH;
  if (!(await fileExists(configPath))) {
    return { configPath, projects: [] };
  }
  const parsed = JSON.parse(await readFile(configPath, "utf8"));
  return { configPath, ...parsed, projects: Array.isArray(parsed.projects) ? parsed.projects : [] };
}

async function saveExampleConfig(filePath) {
  const example = {
    projects: [
      {
        name: "example-project",
        workspace: "/path/to/project",
        hostPort: 31001,
        containerPort: 3000
      }
    ]
  };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(example, null, 2)}\n`, { mode: 0o600 });
}

function getProject(config, name) {
  return config.projects.find((project) => project && project.name === name) || null;
}

async function dockerPs(args) {
  const { stdout } = await exec("docker", args);
  return stdout.trim();
}

async function runningContainerForWorkspace(workspace) {
  return dockerPs(["ps", "--filter", `label=devcontainer.local_folder=${workspace}`, "--format", "{{.ID}}"])
    .then((out) => out.split(/\s+/).filter(Boolean)[0] || "");
}

async function anyContainerForWorkspace(workspace) {
  return dockerPs(["ps", "-a", "--filter", `label=devcontainer.local_folder=${workspace}`, "--format", "{{.ID}}"])
    .then((out) => out.split(/\s+/).filter(Boolean)[0] || "");
}

async function ensureContainer(project, noBuild) {
  if (!project.workspace) {
    fail(`Project '${project.name}' needs a workspace path in config or --workspace.`);
  }

  let id = await runningContainerForWorkspace(project.workspace);
  if (id) return id;

  const existing = await anyContainerForWorkspace(project.workspace);
  if (existing) {
    await exec("docker", ["start", existing]);
    return existing;
  }

  if (noBuild) {
    fail(`No running/built devcontainer found for '${project.name}' and --no-build was set.`);
  }
  if (!(await commandExists("devcontainer"))) {
    fail("Dev Containers CLI is required to build/start a missing devcontainer.");
  }

  const config = path.join(project.workspace, ".devcontainer", "devcontainer.json");
  await exec("devcontainer", ["up", "--workspace-folder", project.workspace, "--config", config]);
  id = await runningContainerForWorkspace(project.workspace);
  if (!id) fail(`devcontainer up completed but no container was found for '${project.name}'.`);
  return id;
}

async function inspect(containerId, template) {
  const { stdout } = await exec("docker", ["inspect", "--format", template, containerId]);
  return stdout.trim();
}

async function containerWorkspace(containerId, fallbackName) {
  const configFile = await inspect(containerId, "{{ index .Config.Labels \"devcontainer.config_file\" }}").catch(() => "");
  if (configFile && await fileExists(configFile)) {
    try {
      const parsed = JSON.parse(await readFile(configFile, "utf8"));
      if (typeof parsed.workspaceFolder === "string" && parsed.workspaceFolder.length > 0) {
        return parsed.workspaceFolder;
      }
    } catch {}
  }
  return `/workspaces/${sanitizeName(fallbackName)}`;
}

async function containerIp(containerId) {
  return inspect(containerId, "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}");
}

async function dockerExec(containerId, workdir, script) {
  return exec("docker", ["exec", "-u", "vscode", "-w", workdir, containerId, "zsh", "-lc", script], {
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function ensureOpenChamber(project, containerId) {
  const containerPort = Number(project.containerPort || DEFAULT_CONTAINER_PORT);
  const workspace = await containerWorkspace(containerId, project.name);
  const projectsDir = path.posix.join(workspace, "projects");
  const script = `
set -euo pipefail
mkdir -p "$HOME/.secrets"
chmod 700 "$HOME/.secrets"
if [[ ! -s "$HOME/.secrets/openchamber-ui-password" ]]; then
  python3 - <<'PY' > "$HOME/.secrets/openchamber-ui-password"
import secrets, string
alphabet = string.ascii_letters + string.digits
print('oc-' + ''.join(secrets.choice(alphabet) for _ in range(24)))
PY
  chmod 600 "$HOME/.secrets/openchamber-ui-password"
fi
pw="$(cat "$HOME/.secrets/openchamber-ui-password")"
if ! command -v openchamber >/dev/null 2>&1; then
  curl -fsSL https://raw.githubusercontent.com/openchamber/openchamber/main/scripts/install.sh | bash >&2
fi
openchamber stop --port ${containerPort} >/dev/null 2>&1 || true
OPENCHAMBER_UI_PASSWORD="$pw" openchamber --lan --port ${containerPort} >/dev/null
curl -fsS http://127.0.0.1:${containerPort}/health >/dev/null
printf '%s' "$pw"
`;
  const { stdout } = await dockerExec(containerId, projectsDir, script);
  return stdout.trim();
}

async function ensureBridge(project, containerId) {
  const name = sanitizeName(project.name);
  const hostPort = Number(project.hostPort);
  const containerPort = Number(project.containerPort || DEFAULT_CONTAINER_PORT);
  if (!Number.isInteger(hostPort) || hostPort <= 0) fail(`Project '${project.name}' needs a valid hostPort.`);
  const ip = await containerIp(containerId);
  const bridgeName = `${name}-openchamber-bridge`;
  await exec("docker", ["rm", "-f", bridgeName]).catch(() => null);
  await exec("docker", [
    "run", "-d",
    "--name", bridgeName,
    "--restart", "unless-stopped",
    "-p", `127.0.0.1:${hostPort}:${hostPort}`,
    "alpine/socat",
    "-d", "-d", `TCP-LISTEN:${hostPort},fork,reuseaddr`, `TCP:${ip}:${containerPort}`
  ]);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await exec("curl", ["-fsS", `http://127.0.0.1:${hostPort}/health`]);
      return bridgeName;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  await exec("curl", ["-fsS", `http://127.0.0.1:${hostPort}/health`]);
  return bridgeName;
}

async function tailscaleDnsName() {
  if (!(await commandExists("tailscale"))) return "";
  try {
    const { stdout } = await exec("tailscale", ["status", "--json"]);
    const parsed = JSON.parse(stdout);
    return String(parsed.Self?.DNSName || "").replace(/\.$/, "");
  } catch {
    return "";
  }
}

async function ensureTailscaleServe(project) {
  if (!(await commandExists("tailscale"))) fail("tailscale is required on the host.");
  await exec("tailscale", ["serve", `--https=${project.hostPort}`, "--bg", `http://127.0.0.1:${project.hostPort}`]);
}

async function startProject(project, noBuild) {
  const containerId = await ensureContainer(project, noBuild);
  const password = await ensureOpenChamber(project, containerId);
  await ensureBridge(project, containerId);
  await ensureTailscaleServe(project);
  const dns = await tailscaleDnsName();
  const url = `https://${dns || "<tailscale-hostname>"}:${project.hostPort}/`;
  console.log(`${project.name} OpenChamber`);
  console.log(`URL:      ${url}`);
  console.log(`Password: ${password}`);
}

async function stopProject(project) {
  const safeName = sanitizeName(project.name);
  const hostPort = String(project.hostPort || "");
  if (hostPort) await exec("tailscale", ["serve", `--https=${hostPort}`, "off"]).catch(() => null);
  await exec("docker", ["rm", "-f", `${safeName}-openchamber-bridge`]).catch(() => null);
  if (project.workspace) {
    const containerId = await runningContainerForWorkspace(project.workspace);
    if (containerId) {
      await exec("docker", ["exec", "-u", "vscode", containerId, "sh", "-lc", `openchamber stop --port ${project.containerPort || DEFAULT_CONTAINER_PORT} >/dev/null 2>&1 || true`]).catch(() => null);
    }
  }
  console.log(`Stopped ${project.name}.`);
}

async function statusProject(project) {
  const bridge = `${sanitizeName(project.name)}-openchamber-bridge`;
  const bridgeStatus = await inspect(bridge, "{{.State.Status}}").catch(() => "no-bridge");
  const containerId = project.workspace ? await runningContainerForWorkspace(project.workspace) : "";
  const dns = await tailscaleDnsName();
  console.log(`${project.name}`);
  console.log(`  port:      ${project.hostPort || "unset"}`);
  console.log(`  container: ${containerId || "not running"}`);
  console.log(`  bridge:    ${bridgeStatus}`);
  if (project.hostPort) console.log(`  url:       https://${dns || "<tailscale-hostname>"}:${project.hostPort}/`);
}

function mergeCliProject(project, options) {
  return {
    ...project,
    name: options.name || project?.name,
    workspace: options.workspace || project?.workspace,
    hostPort: options.hostPort || project?.hostPort,
    containerPort: options.containerPort || project?.containerPort || DEFAULT_CONTAINER_PORT,
  };
}

function parseOptions(args) {
  const options = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--workspace") options.workspace = args[++i];
    else if (arg === "--host-port") options.hostPort = Number(args[++i]);
    else if (arg === "--container-port") options.containerPort = Number(args[++i]);
    else if (arg === "--no-build") options.noBuild = true;
    else rest.push(arg);
  }
  return { options, rest };
}

async function main() {
  const [cmd, ...raw] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    return;
  }
  const config = await loadConfig();
  if (cmd === "init-config") {
    await saveExampleConfig(config.configPath);
    console.log(`Wrote ${config.configPath}`);
    return;
  }
  if (cmd === "list") {
    for (const project of config.projects) await statusProject(project);
    return;
  }
  const { options, rest } = parseOptions(raw);
  const name = rest[0];
  if (!name && cmd !== "status") fail(`${cmd} requires a project name.`);
  if ((cmd === "status" || cmd === "stop") && name === "all") {
    for (const project of config.projects) {
      if (cmd === "status") await statusProject(project);
      else await stopProject(project);
    }
    return;
  }
  const configured = name ? getProject(config, name) : null;
  if (!configured && !options.workspace && cmd !== "status") {
    fail(`Project '${name}' not found in ${config.configPath}. Use --workspace/--host-port or run init-config.`);
  }
  const project = mergeCliProject(configured || {}, { ...options, name });
  if (cmd === "start") await startProject(project, Boolean(options.noBuild));
  else if (cmd === "stop") await stopProject(project);
  else if (cmd === "status") await statusProject(project);
  else usage();
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
