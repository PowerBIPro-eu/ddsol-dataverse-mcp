import { DataverseClient } from "../dataverse-client.js";

// Reads metadata back right after a write so tool results show what Dataverse actually
// stored. "Consistency: Strong" bypasses the metadata cache, which can otherwise return
// the state from before the change for up to about 30 seconds.
export const STRONG_CONSISTENCY = { Consistency: "Strong" };

export async function readBack<T = any>(
  client: DataverseClient,
  endpoint: string,
  select: string[]
): Promise<{ value?: T; error?: string }> {
  try {
    const value = await client.getMetadata<T>(endpoint, { $select: select.join(",") }, STRONG_CONSISTENCY);
    return { value };
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { error: message };
  }
}

/** One line per requested setting: the stored value, or a warning when it differs. */
export function compareStored(label: string, requested: unknown, stored: unknown): string {
  if (stored === undefined || stored === null) {
    return `${label}: could not be read back.`;
  }
  if (requested !== undefined && requested !== stored) {
    return `WARNING: ${label} was requested as '${requested}', but Dataverse reports '${stored}'.`;
  }
  return `${label}: ${stored}`;
}
