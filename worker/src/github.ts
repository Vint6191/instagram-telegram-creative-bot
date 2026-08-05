import type { Env, GitHubDispatchInputs } from "./types";

export class GitHubDispatchError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubDispatchError";
  }
}

export async function dispatchDownloadWorkflow(
  env: Env,
  inputs: GitHubDispatchInputs,
): Promise<{ workflowRunId?: number; htmlUrl?: string }> {
  const workflow = env.GITHUB_WORKFLOW || "process-instagram.yml";
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "instagram-creative-telegram-bot",
      "x-github-api-version": "2026-03-10",
    },
    body: JSON.stringify({
      ref: env.GITHUB_REF || "main",
      inputs,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new GitHubDispatchError(
      `GitHub workflow dispatch failed (${response.status}): ${details.slice(0, 500)}`,
      response.status,
    );
  }

  if (response.status === 204) return {};

  try {
    const body = (await response.json()) as {
      workflow_run_id?: number;
      html_url?: string;
    };
    const result: { workflowRunId?: number; htmlUrl?: string } = {};
    if (body.workflow_run_id !== undefined) result.workflowRunId = body.workflow_run_id;
    if (body.html_url !== undefined) result.htmlUrl = body.html_url;
    return result;
  } catch {
    return {};
  }
}
