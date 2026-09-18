import { SessionRepository } from "@theaihatch/storage";

export async function initializeStorage(dataDirectory: string): Promise<void> {
  let repository: SessionRepository | undefined;
  try {
    repository = new SessionRepository(dataDirectory);
  } finally {
    repository?.close();
  }
}
