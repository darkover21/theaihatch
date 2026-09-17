export interface Keychain {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export class MemoryKeychain implements Keychain {
  private readonly values = new Map<string, string>();
  async get(account: string): Promise<string | null> { return this.values.get(account) ?? null; }
  async set(account: string, value: string): Promise<void> { this.values.set(account, value); }
  async delete(account: string): Promise<void> { this.values.delete(account); }
}

export class KeytarKeychain implements Keychain {
  constructor(private readonly service = "theaihatch") {}

  private async keytar(): Promise<{ getPassword(service: string, account: string): Promise<string | null>; setPassword(service: string, account: string, password: string): Promise<void>; deletePassword(service: string, account: string): Promise<boolean> }> {
    const module = await import("keytar");
    return module;
  }

  async get(account: string): Promise<string | null> { return (await this.keytar()).getPassword(this.service, account); }
  async set(account: string, value: string): Promise<void> { await (await this.keytar()).setPassword(this.service, account, value); }
  async delete(account: string): Promise<void> { await (await this.keytar()).deletePassword(this.service, account); }
}
