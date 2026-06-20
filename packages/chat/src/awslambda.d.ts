/**
 * Lambda Response Streaming のためのグローバル `awslambda` の最小型定義。
 * マネージドランタイム(nodejs)が提供するが公式型が無いため自前で宣言する。
 */
import type { Writable } from "node:stream";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace awslambda {
    interface ResponseStream extends Writable {
      setContentType(contentType: string): void;
    }

    interface ResponseStreamMetadata {
      statusCode?: number;
      headers?: Record<string, string>;
      cookies?: string[];
    }

    namespace HttpResponseStream {
      function from(
        stream: ResponseStream,
        metadata: ResponseStreamMetadata,
      ): ResponseStream;
    }

    function streamifyResponse<TEvent = unknown, TContext = unknown>(
      handler: (
        event: TEvent,
        responseStream: ResponseStream,
        context: TContext,
      ) => Promise<void>,
    ): (event: TEvent, context: TContext) => Promise<void>;
  }
}

export {};
