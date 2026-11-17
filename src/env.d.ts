interface LanguageModelAvailabilityOptions {
  expectedInputs?: Array<{ type: 'text' | 'image'; languages?: string[] }>;
  expectedOutputs?: Array<{ type: 'text'; languages?: string[] }>;
}

declare global {
  interface Window {
    LanguageModel?: {
      availability: (options?: LanguageModelAvailabilityOptions) => Promise<'available' | 'downloadable' | 'downloading' | 'unavailable'>;
    };
  }
}

export {};
