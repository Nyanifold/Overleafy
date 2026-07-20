import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  OverleafyError,
  type GitCredentialProviderPort,
  type SecretKind,
  type SecretStorePort,
} from "../core/mod.js";

const SERVICE = "overleafy";

function account(profile: string, kind: SecretKind): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(profile)) {
    throw new OverleafyError(
      "BINDING_INVALID",
      "Credential profile contains unsupported characters.",
      {
        remediation:
          "Use letters, numbers, dot, underscore, or hyphen for the profile.",
      },
    );
  }
  return `${profile}:${kind}`;
}

export class KeyringSecretStore implements SecretStorePort {
  async get(profile: string, kind: SecretKind): Promise<string | undefined> {
    try {
      const { Entry } = await import("@napi-rs/keyring");
      return new Entry(SERVICE, account(profile, kind)).getPassword() ?? undefined;
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  async set(
    profile: string,
    kind: SecretKind,
    value: string,
  ): Promise<void> {
    if (value === "") {
      throw new OverleafyError(
        "AUTH_REQUIRED",
        "Refusing to store an empty credential.",
      );
    }
    try {
      const { Entry } = await import("@napi-rs/keyring");
      new Entry(SERVICE, account(profile, kind)).setPassword(value);
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  async delete(profile: string, kind: SecretKind): Promise<void> {
    try {
      const { Entry } = await import("@napi-rs/keyring");
      new Entry(SERVICE, account(profile, kind)).deletePassword();
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  private unavailable(error: unknown): OverleafyError {
    return new OverleafyError(
      "AUTH_REQUIRED",
      "The operating-system credential store is unavailable.",
      {
        remediation:
          "Unlock or configure the system keyring, or provide OVERLEAFY_GIT_TOKEN for non-persistent Git authentication.",
        cause: error,
      },
    );
  }
}

const CONFIG_FILE = ".overleaf_config.json";

function configPath(): string {
  return path.join(os.homedir(), CONFIG_FILE);
}

async function readConfig(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(configPath(), "utf8");
    return JSON.parse(raw) as Record<string, string>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeConfig(data: Record<string, string>): Promise<void> {
  const target = configPath();
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.overleaf_config-${randomUUID()}.tmp`);

  await mkdir(dir, { recursive: true });
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, target);
  await chmod(target, 0o600);
}

export class FileSecretStore implements SecretStorePort {
  async get(profile: string, kind: SecretKind): Promise<string | undefined> {
    const all = await readConfig();
    return all[`${profile}:${kind}`];
  }

  async set(
    profile: string,
    kind: SecretKind,
    value: string,
  ): Promise<void> {
    if (value === "") {
      throw new OverleafyError(
        "AUTH_REQUIRED",
        "Refusing to store an empty credential.",
      );
    }
    const all = await readConfig();
    all[`${profile}:${kind}`] = value;
    await writeConfig(all);
  }

  async delete(profile: string, kind: SecretKind): Promise<void> {
    const all = await readConfig();
    delete all[`${profile}:${kind}`];
    await writeConfig(all);
  }
}

export class ProfileGitCredentials implements GitCredentialProviderPort {
  constructor(private readonly secrets: SecretStorePort) {}

  async getGitToken(profile: string): Promise<string | undefined> {
    const environmentToken = process.env.OVERLEAFY_GIT_TOKEN;
    if (environmentToken !== undefined && environmentToken !== "") {
      return environmentToken;
    }
    return this.secrets.get(profile, "git-token");
  }
}

export class MemorySecretStore implements SecretStorePort {
  private readonly values = new Map<string, string>();

  async get(profile: string, kind: SecretKind): Promise<string | undefined> {
    return this.values.get(account(profile, kind));
  }

  async set(
    profile: string,
    kind: SecretKind,
    value: string,
  ): Promise<void> {
    this.values.set(account(profile, kind), value);
  }

  async delete(profile: string, kind: SecretKind): Promise<void> {
    this.values.delete(account(profile, kind));
  }
}
