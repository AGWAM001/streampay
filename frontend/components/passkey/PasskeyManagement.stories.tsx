import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";

import { PasskeyCredentialList } from "./PasskeyCredentialList";
import { PasskeyRegisterPanel } from "./PasskeyRegisterPanel";
import { PasskeyRecoveryFlow } from "./PasskeyRecoveryFlow";
import { PasskeyUnsupportedBanner } from "./PasskeyUnsupportedBanner";
import type { PasskeyCredentialInfo, WebAuthnSupportStatus } from "../../lib/passkey-manager";

const sampleCredentials: PasskeyCredentialInfo[] = [
  {
    id: "cred-macbook-touchid-01",
    deviceLabel: "MacBook Pro Touch ID",
    attachment: "platform",
    createdAt: 1700000000,
    lastUsedAt: 1700500000,
    signCount: 14,
    requireUV: true,
    status: "active",
  },
  {
    id: "cred-yubikey-5c-02",
    deviceLabel: "YubiKey 5C Backup",
    attachment: "cross-platform",
    createdAt: 1700100000,
    lastUsedAt: null,
    signCount: 0,
    requireUV: false,
    status: "active",
  },
];

const fullSupport: WebAuthnSupportStatus = {
  supported: true,
  platformAvailable: true,
  roamingAvailable: true,
};

const roamingOnlySupport: WebAuthnSupportStatus = {
  supported: true,
  platformAvailable: false,
  roamingAvailable: true,
  reason: "No built-in platform authenticator detected; roaming USB/NFC security keys remain available.",
};

const unsupportedEnv: WebAuthnSupportStatus = {
  supported: false,
  platformAvailable: false,
  roamingAvailable: false,
  reason: "WebAuthn is not supported in this browser. Use a modern browser or connect with Freighter.",
};

const meta = {
  title: "Passkey/PasskeyCredentialList",
  component: PasskeyCredentialList,
  tags: ["autodocs"],
  args: {
    credentials: sampleCredentials,
    onRevoke: fn(async () => {}),
  },
} satisfies Meta<typeof PasskeyCredentialList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const Empty: Story = {
  args: { credentials: [] },
};

export const RegisterPlatformAuthenticator: StoryObj<typeof PasskeyRegisterPanel> = {
  render: () => (
    <PasskeyRegisterPanel
      support={fullSupport}
      onRegisterDevice={fn(async () => {})}
    />
  ),
};

export const RegisterRoamingKeyOnly: StoryObj<typeof PasskeyRegisterPanel> = {
  render: () => (
    <PasskeyRegisterPanel
      support={roamingOnlySupport}
      onRegisterDevice={fn(async () => {})}
    />
  ),
};

export const RecoveryWithExistingCredential: StoryObj<typeof PasskeyRecoveryFlow> = {
  render: () => (
    <PasskeyRecoveryFlow
      credentials={sampleCredentials}
      support={fullSupport}
      governanceApproved={false}
      onRecover={fn(async () => {})}
    />
  ),
};

export const RecoveryWithGovernanceApproval: StoryObj<typeof PasskeyRecoveryFlow> = {
  render: () => (
    <PasskeyRecoveryFlow
      credentials={[]}
      support={fullSupport}
      governanceApproved={true}
      onRecover={fn(async () => {})}
    />
  ),
};

export const RecoveryBlocked: StoryObj<typeof PasskeyRecoveryFlow> = {
  render: () => (
    <PasskeyRecoveryFlow
      credentials={[]}
      support={fullSupport}
      governanceApproved={false}
      onRecover={fn(async () => {})}
    />
  ),
};

export const UnsupportedBrowserFallback: StoryObj<typeof PasskeyUnsupportedBanner> = {
  render: () => <PasskeyUnsupportedBanner support={unsupportedEnv} />,
};

