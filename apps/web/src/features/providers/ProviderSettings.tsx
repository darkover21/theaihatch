import { useState } from "react";

export interface ProviderModelOption { id: string; displayName: string; }
export interface ProviderSettingsValue { id: string; label: string; models: ProviderModelOption[]; selectedModel: string; configured: boolean; }

export interface ProviderSettingsProps {
  providers: readonly ProviderSettingsValue[];
  onSelect: (providerId: string, modelId: string) => void;
  onSaveSecret: (providerId: string, secret: string) => Promise<void>;
  onTest: (providerId: string) => Promise<string>;
}

export function ProviderSettings({ providers, onSelect, onSaveSecret, onTest }: ProviderSettingsProps) {
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  return <section aria-label="Provider settings" className="settings-panel"><h2>Providers</h2>{providers.map((provider) => <div className="provider-row" key={provider.id}><strong>{provider.label}</strong><span>{provider.configured ? "configured" : "needs credentials"}</span><select aria-label={`${provider.label} model`} value={provider.selectedModel} onChange={(event) => onSelect(provider.id, event.target.value)}>{provider.models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select><input aria-label={`${provider.label} API key`} type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="Stored in OS keychain" /><button onClick={() => void onSaveSecret(provider.id, secret).then(() => { setSecret(""); setMessage("Credential stored in OS keychain"); })}>Save key</button><button onClick={() => void onTest(provider.id).then(setMessage)}>Test connection</button></div>)}{message !== null && <p role="status">{message}</p>}</section>;
}
