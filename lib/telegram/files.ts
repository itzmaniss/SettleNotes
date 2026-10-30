export const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export class FileTooLargeError extends Error {
  readonly sizeBytes?: number;
  readonly maxBytes: number;

  constructor(message: string, options: { sizeBytes?: number; maxBytes: number }) {
    super(message);
    this.name = "FileTooLargeError";
    this.sizeBytes = options.sizeBytes;
    this.maxBytes = options.maxBytes;
  }
}

export class TelegramDownloadError extends Error {
  readonly status?: number;

  constructor(message: string, options: { status?: number } = {}) {
    super(message);
    this.name = "TelegramDownloadError";
    if (options.status !== undefined) this.status = options.status;
  }
}

export type FileFetchDeps = {
  // Passed in by the caller, normally `bot.api.getFile` bound from grammY.
  getFile: (fileId: string) => Promise<{ file_path?: string; file_size?: number }>;
  fetch?: typeof fetch;
  botToken: string;
};

export async function downloadTelegramFile(
  fileId: string,
  deps: FileFetchDeps
): Promise<{ buffer: Buffer; filePath: string; sizeBytes: number }> {
  const file = await deps.getFile(fileId);

  if (file.file_size !== undefined && file.file_size > TELEGRAM_MAX_DOWNLOAD_BYTES) {
    throw new FileTooLargeError(
      `Telegram file is ${file.file_size} bytes, over the ${TELEGRAM_MAX_DOWNLOAD_BYTES} byte limit`,
      { sizeBytes: file.file_size, maxBytes: TELEGRAM_MAX_DOWNLOAD_BYTES }
    );
  }

  if (!file.file_path) {
    throw new TelegramDownloadError("Telegram did not return a file path for this file");
  }

  // The URL embeds the bot token, so build it locally and never put it in an
  // error message, log line, or rethrown cause.
  const url = `https://api.telegram.org/file/bot${deps.botToken}/${file.file_path}`;
  const doFetch = deps.fetch ?? fetch;

  let response: Response;
  try {
    response = await doFetch(url);
  } catch {
    throw new TelegramDownloadError("Could not reach the Telegram file server");
  }

  if (!response.ok) {
    throw new TelegramDownloadError(`Telegram file download failed with HTTP ${response.status}`, {
      status: response.status,
    });
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > TELEGRAM_MAX_DOWNLOAD_BYTES) {
    throw new FileTooLargeError(
      `Telegram file is ${buffer.byteLength} bytes, over the ${TELEGRAM_MAX_DOWNLOAD_BYTES} byte limit`,
      { sizeBytes: buffer.byteLength, maxBytes: TELEGRAM_MAX_DOWNLOAD_BYTES }
    );
  }

  return { buffer, filePath: file.file_path, sizeBytes: buffer.byteLength };
}
