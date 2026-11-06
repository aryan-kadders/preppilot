/// <reference types="vite/client" />
import { ElectronAPI } from './types/electron';

interface ImportMetaEnv {
    readonly VITE_APP_VERSION?: string;
    readonly VITE_BUILD_COMMIT?: string;
    /** PrepPilot's release host (scripts/lib/releases-url.cjs); '' when unset. */
    readonly VITE_RELEASES_URL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

interface Window {
    electronAPI: ElectronAPI
}
