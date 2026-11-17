import { describe, expect, it } from 'vitest';
import {
  connectionProfileMatches,
  createConnectionProfile,
  defaultOaiSettings,
  loadConnectionProfiles,
  loadTextgenSettings,
  planConnectionProfile,
  profileApiName,
  profileNameTaken,
  readProfileFields,
  resolveProfileApi,
  suggestProfileName,
  updateConnectionProfile,
  type ConnectionProfile,
  type ConnectionState,
} from '../src/index.js';

const PROXIES = [
  { name: 'None', url: '' },
  { name: 'Relay', url: 'https://relay.example/v1' },
];

function ccState(oai: Record<string, unknown> = {}, rest: Partial<ConnectionState> = {}) {
  return {
    mainApi: 'openai',
    oai: { ...defaultOaiSettings(), ...oai },
    tg: loadTextgenSettings({}),
    proxyName: 'None',
    secretId: null,
    ...rest,
  } satisfies ConnectionState;
}

function tcState(tg: Record<string, unknown> = {}, rest: Partial<ConnectionState> = {}) {
  return {
    mainApi: 'textgenerationwebui',
    oai: defaultOaiSettings(),
    tg: { ...loadTextgenSettings({}), ...tg },
    proxyName: 'None',
    secretId: null,
    ...rest,
  } satisfies ConnectionState;
}

const custom = () =>
  ccState(
    {
      chat_completion_source: 'custom',
      custom_url: 'https://one.example/v1',
      custom_model: 'model-a',
    },
    { secretId: 'key-1' },
  );

describe('profile API names', () => {
  it('uses the names ST stores', () => {
    expect(profileApiName('cc', 'makersuite')).toBe('google');
    expect(profileApiName('cc', 'openrouter')).toBe('openrouter');
    expect(profileApiName('tc', 'openrouter')).toBe('openrouter-text');
    expect(profileApiName('tc', 'koboldcpp')).toBe('koboldcpp');
  });

  it('resolves names and aliases back', () => {
    expect(resolveProfileApi('oai')).toEqual({ mode: 'cc', source: 'openai' });
    expect(resolveProfileApi('Google')).toEqual({ mode: 'cc', source: 'makersuite' });
    expect(resolveProfileApi('openrouter')).toEqual({ mode: 'cc', source: 'openrouter' });
    expect(resolveProfileApi('openrouter-text')).toEqual({ mode: 'tc', type: 'openrouter' });
    expect(resolveProfileApi('kcpp')).toEqual({ mode: 'tc', type: 'koboldcpp' });
    expect(resolveProfileApi('ollama')).toEqual({ mode: 'tc', type: 'ollama' });
    expect(resolveProfileApi('nope')).toBeNull();
  });
});

describe('readProfileFields', () => {
  it('reads a custom Chat Completion connection', () => {
    expect(readProfileFields(custom())).toEqual({
      mode: 'cc',
      fields: {
        api: 'custom',
        'api-url': 'https://one.example/v1',
        model: 'model-a',
        proxy: 'None',
        'prompt-post-processing': 'none',
        'secret-id': 'key-1',
      },
    });
  });

  it('leaves empty fields out and reads endpoint picks', () => {
    const { fields } = readProfileFields(
      ccState({ chat_completion_source: 'zai', zai_model: '', zai_endpoint: '' }),
    );
    expect(fields['api-url']).toBe('common');
    expect('model' in fields).toBe(false);
    expect('secret-id' in fields).toBe(false);
  });

  it('reads a Text Completion connection', () => {
    const state = tcState({
      type: 'ollama',
      server_urls: { ollama: 'http://127.0.0.1:11434' },
      ollama_model: 'local-model',
    });
    expect(readProfileFields(state)).toEqual({
      mode: 'tc',
      fields: { api: 'ollama', 'api-url': 'http://127.0.0.1:11434', model: 'local-model' },
    });
  });
});

describe('loadConnectionProfiles', () => {
  it('tolerates missing and broken data', () => {
    expect(loadConnectionProfiles(undefined)).toEqual({ profiles: [], selectedProfile: null });
    const data = loadConnectionProfiles({
      profiles: [
        null,
        { name: 'no id' },
        { id: 'a', mode: 'tc', name: 'A', preset: 'P' },
        { id: 'b' },
      ],
      selectedProfile: 'gone',
    });
    expect(data.profiles).toEqual([
      { id: 'a', mode: 'tc', name: 'A', preset: 'P' },
      { id: 'b', mode: 'cc', name: 'b' },
    ]);
    expect(data.selectedProfile).toBeNull();
  });

  it('keeps a selection that exists', () => {
    const data = loadConnectionProfiles({
      profiles: [{ id: 'a', name: 'A' }],
      selectedProfile: 'a',
    });
    expect(data.selectedProfile).toBe('a');
  });
});

describe('create / update / match', () => {
  it('creates a profile in ST shape that matches the state it came from', () => {
    const profile = createConnectionProfile('One', custom(), () => 'id-1');
    expect(profile).toMatchObject({
      id: 'id-1',
      mode: 'cc',
      name: 'One',
      exclude: [],
      api: 'custom',
      model: 'model-a',
      'secret-id': 'key-1',
    });
    expect(connectionProfileMatches(profile, custom())).toBe(true);
  });

  it('notices an edit, and an alias is not one', () => {
    const profile = createConnectionProfile('One', custom(), () => 'id-1');
    const edited = custom();
    edited.oai['custom_model'] = 'model-b';
    expect(connectionProfileMatches(profile, edited)).toBe(false);
    expect(connectionProfileMatches(profile, tcState())).toBe(false);

    const openai = ccState({ chat_completion_source: 'openai', openai_model: 'm' });
    const aliased = { ...createConnectionProfile('O', openai, () => 'id-2'), api: 'oai' };
    expect(connectionProfileMatches(aliased, openai)).toBe(true);
  });

  it('update keeps excluded and unhandled fields, drops emptied ones', () => {
    const stored: ConnectionProfile = {
      ...createConnectionProfile('One', custom(), () => 'id-1'),
      exclude: ['model'],
      preset: 'My preset',
      'stop-strings': '[]',
    };
    const edited = custom();
    edited.oai['custom_url'] = 'https://two.example/v1';
    edited.oai['custom_model'] = 'model-b';
    edited.secretId = null;
    const next = updateConnectionProfile(stored, edited);
    expect(next['api-url']).toBe('https://two.example/v1');
    expect(next['model']).toBe('model-a');
    expect('secret-id' in next).toBe(false);
    expect(next['preset']).toBe('My preset');
    expect(next['stop-strings']).toBe('[]');
    expect(stored['api-url']).toBe('https://one.example/v1');
    expect(connectionProfileMatches(next, edited)).toBe(true);
  });

  it('update in the other mode drops the fields that mode lacks', () => {
    const stored = createConnectionProfile('One', custom(), () => 'id-1');
    const next = updateConnectionProfile(stored, tcState({ type: 'ollama' }));
    expect(next.mode).toBe('tc');
    expect(next['api']).toBe('ollama');
    expect('proxy' in next).toBe(false);
    expect('prompt-post-processing' in next).toBe(false);
  });
});

describe('planConnectionProfile', () => {
  it('switches source, address, model, proxy and key', () => {
    const profile: ConnectionProfile = {
      id: 'p',
      mode: 'cc',
      name: 'P',
      api: 'custom',
      'api-url': 'https://two.example/v1',
      model: 'model-b',
      proxy: 'relay',
      'prompt-post-processing': 'strict',
      'secret-id': 'key-2',
    };
    expect(planConnectionProfile(profile, tcState(), PROXIES)).toEqual({
      mainApi: 'openai',
      oai: {
        chat_completion_source: 'custom',
        custom_url: 'https://two.example/v1',
        custom_model: 'model-b',
        reverse_proxy: 'https://relay.example/v1',
        custom_prompt_post_processing: 'strict',
      },
      tg: {},
      proxy: 'Relay',
      secret: 'key-2',
      skipped: [],
    });
  });

  it('applies only what the profile holds', () => {
    const plan = planConnectionProfile(
      { id: 'p', mode: 'cc', name: 'P', model: 'model-c', 'prompt-post-processing': 'none' },
      custom(),
      PROXIES,
    );
    expect(plan).toEqual({
      mainApi: 'openai',
      oai: { custom_model: 'model-c', custom_prompt_post_processing: '' },
      tg: {},
      proxy: null,
      secret: null,
      skipped: [],
    });
  });

  it('reports what it cannot apply', () => {
    const plan = planConnectionProfile(
      {
        id: 'p',
        mode: 'cc',
        name: 'P',
        api: 'zai',
        'api-url': 'elsewhere',
        proxy: 'Missing',
        'prompt-post-processing': 'odd',
      },
      custom(),
      PROXIES,
    );
    expect(plan.oai).toEqual({ chat_completion_source: 'zai' });
    expect(plan.skipped).toEqual(['api-url', 'proxy', 'prompt-post-processing']);
    expect(
      planConnectionProfile({ id: 'q', mode: 'cc', name: 'Q', api: 'nope' }, custom(), PROXIES)
        .skipped,
    ).toEqual(['api']);
  });

  it('plans a Text Completion profile', () => {
    const state = tcState({ server_urls: { ooba: 'http://127.0.0.1:5000' } });
    const plan = planConnectionProfile(
      {
        id: 'p',
        mode: 'tc',
        name: 'P',
        api: 'ollama',
        'api-url': 'http://10.0.0.2:11434',
        model: 'm',
      },
      state,
      PROXIES,
    );
    expect(plan.mainApi).toBe('textgenerationwebui');
    expect(plan.tg).toEqual({
      type: 'ollama',
      server_urls: { ooba: 'http://127.0.0.1:5000', ollama: 'http://10.0.0.2:11434' },
      ollama_model: 'm',
    });
    expect(plan.oai).toEqual({});
  });
});

describe('names', () => {
  it('knows taken names', () => {
    const profiles = [createConnectionProfile('One', custom(), () => 'id-1')];
    expect(profileNameTaken(profiles, 'One')).toBe(true);
    expect(profileNameTaken(profiles, 'One', 'id-1')).toBe(false);
    expect(profileNameTaken(profiles, 'Two')).toBe(false);
    expect(profileNameTaken([], '<None>')).toBe(true);
  });

  it('suggests the host and model, numbered when taken', () => {
    expect(suggestProfileName(custom(), [])).toBe('one.example model-a');
    const taken = [createConnectionProfile('one.example model-a', custom(), () => 'id-1')];
    expect(suggestProfileName(custom(), taken)).toBe('one.example model-a 2');
    const openai = ccState({ chat_completion_source: 'openai', openai_model: 'm' });
    expect(suggestProfileName(openai, [])).toBe('openai m');
  });
});
