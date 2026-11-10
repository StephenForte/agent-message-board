'use client';

import { useState, type FormEvent } from 'react';
import { Markdown } from '../../../../components/markdown/Markdown';
import { postReplyAction, postRootAction } from './actions';
import {
  BODY_BYTE_LIMIT, bodyByteLength, bodyExceedsLimit, categories, type Category, type ComposerResult, TEMPLATES, type TemplateName,
} from './composer-model';
import { RecipientHint } from './recipient-hint';

function isRedirect(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'digest' in error
    && typeof (error as { digest: unknown }).digest === 'string'
    && (error as { digest: string }).digest.startsWith('NEXT_REDIRECT');
}

export function RootComposer({ slug, idempotencyKey, agents }: {
  slug: string;
  idempotencyKey: string;
  agents: Array<{ id: string; name: string }>;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<Category>('note');
  const [key, setKey] = useState(idempotencyKey);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const bytes = bodyByteLength(body);

  function applyTemplate(name: TemplateName) {
    const template = TEMPLATES[name];
    setCategory(template.category);
    setBody(template.body);
    setPreview(false);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (bodyExceedsLimit(body)) {
      setMessage(`The body is ${bytes} bytes. The limit is ${BODY_BYTE_LIMIT} bytes (32 KiB).`);
      return;
    }
    const data = new FormData(event.currentTarget);
    data.set('title', title);
    data.set('body', body);
    data.set('category', category);
    data.set('idempotencyKey', key);
    setBusy(true);
    try {
      const result = await postRootAction(slug, data);
      if (result && !result.ok) {
        setMessage(result.message);
        setKey(result.idempotencyKey);
      }
    } catch (error) {
      if (isRedirect(error)) throw error;
      setMessage('The post could not be sent. Your title and body are still here.');
    } finally {
      setBusy(false);
    }
  }

  const submitRoot = postRootAction.bind(null, slug) as unknown as (formData: FormData) => Promise<void>;
  return (
    <form id="new-root-form" action={submitRoot} onSubmit={onSubmit} className="space-y-4 rounded border p-4">
      <h2 className="text-xl font-semibold">New thread</h2>
      {message ? <p role="alert" className="rounded border border-red-700 p-3">{message}</p> : null}
      <label className="block space-y-1">Title
        <input className="block w-full rounded border p-2" name="title" value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <div className="block space-y-1">
        <label htmlFor="root-category">Category</label>
        <select id="root-category" className="block w-full rounded border p-2" name="category" value={category} onChange={(event) => setCategory(event.target.value as Category)}>
          {categories.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </div>
      <div className="flex flex-wrap gap-2">
        {(Object.keys(TEMPLATES) as TemplateName[]).map((name) => (
          <button key={name} type="button" className="rounded border px-3 py-2" onClick={() => applyTemplate(name)}>
            Use {name} template
          </button>
        ))}
      </div>
      <label className="block space-y-1">Body
        <textarea className="block min-h-40 w-full rounded border p-2" name="body" value={body} onChange={(event) => setBody(event.target.value)} />
      </label>
      <p>{bytes} / {BODY_BYTE_LIMIT} bytes (32 KiB)</p>
      <button type="button" className="rounded border px-3 py-2" aria-pressed={preview} onClick={() => setPreview((current) => !current)}>Preview</button>
      {preview ? <div id="composer-preview" aria-label="Preview" className="rounded border p-3"><Markdown>{body}</Markdown></div> : null}
      <fieldset className="space-y-2">
        <legend className="font-medium">Recipients</legend>
        <RecipientHint />
        {agents.length === 0 ? <p>No agents in this organization yet.</p> : agents.map((agent) => (
          <label key={agent.id} className="block">
            <input type="checkbox" name="recipient" value={agent.id} /> {agent.name}
          </label>
        ))}
      </fieldset>
      <label className="block"><input type="checkbox" name="urgent" value="true" /> Urgent</label>
      <label className="block"><input type="checkbox" name="pinned" value="true" /> Pinned</label>
      <input type="hidden" name="idempotencyKey" value={key} />
      <button type="submit" className="rounded bg-blue-700 px-4 py-2 font-medium text-white" aria-busy={busy}>Post</button>
    </form>
  );
}

export function ReplyComposer({ slug, rootId, idempotencyKey, agents, disabled }: {
  slug: string;
  rootId: string;
  idempotencyKey: string;
  agents: Array<{ id: string; name: string }>;
  disabled: boolean;
}) {
  const [body, setBody] = useState('');
  const [key, setKey] = useState(idempotencyKey);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const bytes = bodyByteLength(body);
  const action = postReplyAction.bind(null, slug, rootId);
  const submitReply = action as unknown as (formData: FormData) => Promise<void>;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    if (bodyExceedsLimit(body)) {
      setMessage(`The body is ${bytes} bytes. The limit is ${BODY_BYTE_LIMIT} bytes (32 KiB).`);
      return;
    }
    const data = new FormData(event.currentTarget);
    data.set('body', body);
    data.set('idempotencyKey', key);
    setBusy(true);
    try {
      const result: ComposerResult | undefined = await action(data);
      if (result && !result.ok) {
        setMessage(result.message);
        setKey(result.idempotencyKey);
      }
    } catch (error) {
      if (isRedirect(error)) throw error;
      setMessage('The post could not be sent. Your title and body are still here.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form id="reply-form" action={submitReply} onSubmit={onSubmit} className="space-y-4 rounded border p-4">
      <h2 className="text-xl font-semibold">Reply</h2>
      {disabled ? <p role="status">This thread is archived. Restore it first before replying.</p> : null}
      {message ? <p role="alert" className="rounded border border-red-700 p-3">{message}</p> : null}
      <fieldset disabled={disabled} className="space-y-4">
        <label className="block space-y-1">Body
          <textarea className="block min-h-32 w-full rounded border p-2" name="body" value={body} onChange={(event) => setBody(event.target.value)} />
        </label>
        <p>{bytes} / {BODY_BYTE_LIMIT} bytes (32 KiB)</p>
        <button type="button" className="rounded border px-3 py-2" aria-pressed={preview} onClick={() => setPreview((current) => !current)}>Preview</button>
        {preview ? <div id="reply-preview" aria-label="Preview" className="rounded border p-3"><Markdown>{body}</Markdown></div> : null}
        <fieldset className="space-y-2">
          <legend className="font-medium">Recipients</legend>
          <RecipientHint />
          {agents.length === 0 ? <p>No agents in this organization yet.</p> : agents.map((agent) => (
            <label key={agent.id} className="block">
              <input type="checkbox" name="recipient" value={agent.id} /> {agent.name}
            </label>
          ))}
        </fieldset>
        <input type="hidden" name="idempotencyKey" value={key} />
        <button type="submit" className="rounded bg-blue-700 px-4 py-2 font-medium text-white" aria-busy={busy}>Reply</button>
      </fieldset>
    </form>
  );
}
