import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

interface ConfigState {
  cdnDomain: string;
  allowSignup: boolean;
  googleClientId: string;
  daemonServerUrl: string;
  // Self-host gate (#3433): when true, every "Create workspace" affordance
  // must be hidden. Defaults to false so unknown / older servers behave like
  // the managed-cloud case.
  workspaceCreationDisabled: boolean;
  // Read-only primary security activation flag from GET /api/config.
  // Remains undefined when omitted or unknown — must never default to false.
  jwtRegistrationRequired?: boolean;
  setCdnDomain: (domain: string) => void;
  setAuthConfig: (config: {
    allowSignup: boolean;
    googleClientId?: string;
    workspaceCreationDisabled?: boolean;
    jwtRegistrationRequired?: boolean;
  }) => void;
  setDaemonConfig: (config: {
    daemonServerUrl?: string;
  }) => void;
}

export const configStore = createStore<ConfigState>((set) => ({
  cdnDomain: "",
  allowSignup: true,
  googleClientId: "",
  daemonServerUrl: "",
  workspaceCreationDisabled: false,
  jwtRegistrationRequired: undefined,
  setCdnDomain: (domain) => set({ cdnDomain: domain }),
  setAuthConfig: ({
    allowSignup,
    googleClientId = "",
    workspaceCreationDisabled = false,
    jwtRegistrationRequired,
  }) =>
    set({
      allowSignup,
      googleClientId,
      workspaceCreationDisabled,
      jwtRegistrationRequired: typeof jwtRegistrationRequired === "boolean" ? jwtRegistrationRequired : undefined,
    }),
  setDaemonConfig: ({ daemonServerUrl = "" }) =>
    set({ daemonServerUrl }),
}));

export function useConfigStore(): ConfigState;
export function useConfigStore<T>(selector: (state: ConfigState) => T): T;
export function useConfigStore<T>(selector?: (state: ConfigState) => T) {
  return useStore(configStore, selector as (state: ConfigState) => T);
}
