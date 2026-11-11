declare module 'mailauth/lib/dkim/verify.js' {
  export function dkimVerify(
    raw: Buffer,
    options: {
      resolver: (name: string, type: string) => Promise<string[][]>;
      minBitLength: number;
    },
  ): Promise<{
    headerFrom?: string[];
    results: Array<{
      id: string;
      status: { result: string };
      algo: string;
      signingDomain?: string;
      signatureTimeValid: boolean;
      canonBodyLengthLimited: boolean;
      signingHeaders?: { keys?: string };
    }>;
  }>;
}
declare module 'mailauth/lib/dkim/sign.js' {
  export function dkimSign(
    raw: string,
    options: { signatureData: Array<Record<string, unknown>> },
  ): Promise<{ signatures: string; errors: unknown[] }>;
}
