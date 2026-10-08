import type { AutobotApi } from '@shared/types';

declare global {
  interface Window {
    autobot: AutobotApi;
  }
}

export {};
