import type { ContentBlock, LLMMessage } from "../types.js";

/**
 * Multimodal content helpers — builders for {@link ContentBlock} values and the
 * canonical text projection used everywhere the SDK needs a plain string view
 * of possibly-multimodal message content (history persistence, token
 * estimation fallbacks, providers without multimodal support, prompts built
 * from transcripts).
 */

/** Text block builder. */
export function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}

/** Image block builder (base64 or URL source). */
export function imageBlock(
  source:
    | { type: "base64"; mediaType: string; data: string }
    | { type: "url"; url: string },
): ContentBlock {
  return { type: "image", source };
}

/** Document block builder (base64 PDF, URL, or Files-API reference). */
export function documentBlock(
  source:
    | { type: "base64"; mediaType: "application/pdf"; data: string }
    | { type: "url"; url: string }
    | { type: "file"; fileId: string },
  opts?: { citations?: { enabled: boolean }; title?: string },
): ContentBlock {
  return {
    type: "document",
    source,
    ...(opts?.citations ? { citations: opts.citations } : {}),
    ...(opts?.title !== undefined ? { title: opts.title } : {}),
  };
}

/** Convenience: a base64-encoded PDF document block. */
export function pdfFromBase64(data: string, title?: string): ContentBlock {
  return documentBlock(
    { type: "base64", mediaType: "application/pdf", data },
    title !== undefined ? { title } : undefined,
  );
}

/**
 * Project message content to plain text: string content passes through
 * unchanged; block arrays concatenate their text blocks and substitute
 * placeholder markers ("[image]", "[document: title]") for non-text blocks.
 * Never throws on malformed input — unknown block shapes become "".
 */
export function contentToText(content: LLMMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      parts.push(block.text ?? "");
    } else if (block.type === "image") {
      parts.push("[image]");
    } else if (block.type === "document") {
      parts.push(block.title ? `[document: ${block.title}]` : "[document]");
    }
  }
  return parts.join("\n");
}
