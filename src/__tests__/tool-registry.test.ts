import { describe, it, expect, afterEach } from 'vitest';
import {
  getAllToolDefinitions,
  isToolDisabled,
  isToolDestructive,
  isActionDisabled,
} from '../tools/index.js';

const ORIG = { ...process.env };

afterEach(() => {
  process.env = { ...ORIG };
});

describe('read/write/destructive classification', () => {
  it('flags reboot and delete tools as destructive', () => {
    expect(isToolDestructive('post_router_reboot')).toBe(true);
    expect(isToolDestructive('post_routers_by_router_id_reboot')).toBe(true);
    expect(isToolDestructive('delete_contacts_by_subject_id')).toBe(true);
  });

  it('does not flag reads or plain writes as destructive', () => {
    expect(isToolDestructive('get_account')).toBe(false);
    expect(isToolDestructive('post_contacts')).toBe(false);
    expect(isToolDestructive('put_address')).toBe(false);
  });

  it('annotates get_* as read-only in the exposed list', () => {
    const get = getAllToolDefinitions().find((t) => t.name === 'get_account')!;
    expect(get.annotations.readOnlyHint).toBe(true);
    expect(get.annotations.destructiveHint).toBe(false);
  });
});

describe('MCP_DISABLED_TOOLS globs', () => {
  it('hides tools matching a glob', () => {
    process.env.MCP_DISABLED_TOOLS = 'delete_*,*reboot*';
    expect(isToolDisabled('delete_contacts_by_subject_id')).toBe(true);
    expect(isToolDisabled('post_routers_by_router_id_reboot')).toBe(true);
    expect(isToolDisabled('get_account')).toBe(false);

    const names = getAllToolDefinitions().map((t) => t.name);
    expect(names).toContain('get_account');
    expect(names.some((n) => n.startsWith('delete_'))).toBe(false);
    expect(names.some((n) => n.includes('reboot'))).toBe(false);
  });
});

describe('MCP_DISABLE_DESTRUCTIVE toggle', () => {
  it('drops every destructive tool from the exposed list', () => {
    process.env.MCP_DISABLE_DESTRUCTIVE = 'true';
    const names = getAllToolDefinitions().map((t) => t.name);
    expect(names).toContain('get_account');
    expect(names.some((n) => n.includes('reboot'))).toBe(false);
    expect(names.some((n) => n.startsWith('delete_'))).toBe(false);
  });
});

describe('MCP_DISABLED_ACTIONS', () => {
  it('matches configured action values', () => {
    process.env.MCP_DISABLED_ACTIONS = 'reboot,reset';
    expect(isActionDisabled('reboot')).toBe(true);
    expect(isActionDisabled('view')).toBe(false);
    expect(isActionDisabled(undefined)).toBe(false);
  });
});
