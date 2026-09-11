import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CandidateArtifact,
  CandidateResult,
  Runner,
  RunnerCapabilities,
  RunnerInputHandle,
  RunnerJobInput,
  RunnerLimits,
} from '../ports.js';

/**
 * 直接把原文件当作 text/plain echo 出去的最简 Runner。
 * 不做真实转换，仅用于验证端到端流程。
 */
export class EchoRunner implements Runner {
  async run(
    input: RunnerJobInput,
    readOnlySource: RunnerInputHandle,
    outputDirectory: string,
    _limits: RunnerLimits,
    signal: AbortSignal,
  ): Promise<CandidateResult> {
    throwIfAborted(signal);
    const artifactRel = 'entry.txt';
    const artifactAbs = join(outputDirectory, artifactRel);
    const body = new TextEncoder().encode(
      `[echo runner] preview=${input.previewId}\nsource=${input.source.filename}\nsize=${input.source.sizeBytes}\nsha256=${readOnlySource.sha256}\n`,
    );
    await writeFile(artifactAbs, body);
    throwIfAborted(signal);
    const sha256 = createHash('sha256').update(body).digest('hex');

    const artifact: CandidateArtifact = {
      relativePath: artifactRel,
      role: 'entry',
      mediaType: 'text/plain; charset=utf-8',
      sizeBytes: body.byteLength,
      sha256,
    };

    return {
      manifest: {
        default_representation_id: 'text',
        representations: [
          {
            id: 'text',
            kind: 'text',
            label: '文本预览',
            status: 'ready',
            completeness: 'complete',
            affects_completeness: true,
            entry_artifact_relative_path: artifactRel,
            coverage: null,
            warnings: [],
            error: null,
          },
        ],
        capabilities: {
          search_scope: 'document',
          static_only: true,
        },
      },
      artifacts: [artifact],
      warnings: [],
    };
  }

  async cancel(_jobId: string): Promise<boolean> {
    return true;
  }

  async capabilities(): Promise<RunnerCapabilities> {
    return {
      protocolVersions: ['1.0'],
      imageDigest: 'sha256:echo-runner',
      fontDigest: 'sha256:none',
      supportedFormats: ['txt', 'md'],
    };
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const reason =
      (signal as { reason?: unknown }).reason ?? new Error('aborted');
    throw reason instanceof Error ? reason : new Error(String(reason));
  }
}
