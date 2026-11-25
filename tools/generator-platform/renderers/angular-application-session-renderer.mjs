import { readFile } from 'node:fs/promises';
import { sessionRenderConfiguration } from '../core/application-design-session.mjs';
import { sha256, stableStringify } from '../core/generation-manifest.mjs';
import { productForms } from '../core/product-identity.mjs';
import { renderTabSessionProjection } from './angular-session-tab-renderer.mjs';

export const SESSION_NATIVE_SOURCES = Object.freeze({
    'auth-context.token.ts':
        'libs/core/src/lib/interceptors/auth-context.token.ts',
    'action-request-request-context.ts':
        'libs/core/src/lib/interceptors/action-request-request-context.ts',
    'cache-context.token.ts':
        'libs/core/src/lib/interceptors/cache-context.token.ts',
    'list-query-request-context.ts':
        'libs/core/src/lib/interceptors/list-query-request-context.ts',
    'native-errors/domain-error.abstract.ts':
        'libs/shared/domain/src/lib/errors/domain-error.abstract.ts',
    'native-errors/http/invalid-payload.error.ts':
        'libs/shared/domain/src/lib/errors/http/invalid-payload.error.ts',
    'native-errors/http/server-response.error.ts':
        'libs/shared/domain/src/lib/errors/http/server-response.error.ts',
});

function sessionTypes() {
    return `import { InjectionToken } from '@angular/core';

export interface SessionProducer {
    readonly page_id: string;
    readonly action_id: string;
    readonly response_status: number;
    readonly result_model_id: string;
}
export interface SessionStage {
    readonly id: string;
    readonly page_id: string;
    readonly predicate: { readonly pointer: string; readonly operator: 'is-null' | 'is-true' };
    readonly completion: {
        readonly producer: SessionProducer;
        readonly effect: 'acknowledge' | 'clear-and-reconnect';
        readonly result_condition?: { readonly pointer: string; readonly equals: boolean };
    };
}
export interface SessionRoute {
    readonly page_id: string;
    readonly path: string;
    readonly access: { readonly mode: 'public' | 'authenticated' | 'authorized'; readonly permissions: readonly string[] };
}
export interface SessionConfiguration {
    readonly storage: 'tab';
    readonly producer: SessionProducer;
    readonly projection: {
        readonly token_pointer: string; readonly subject_pointer: string;
        readonly menu_pointer: string; readonly allowed_paths_pointer: string;
        readonly permissions_pointer?: string;
    };
    readonly stages: readonly SessionStage[];
    readonly landing_page_id: string;
    readonly reconnect_page_id: string;
    readonly logout_label: string;
    readonly menu: { readonly label_pointer: string; readonly path_pointer: string; readonly children_pointer?: string };
    readonly protected_operations: readonly {
        readonly contract_id: string; readonly service_id: string; readonly operation_id: string;
        readonly method: string; readonly path: string; readonly security_scheme_id: string;
    }[];
    readonly routes: readonly SessionRoute[];
}
export interface SessionEndpoint {
    readonly contract_id: string;
    readonly service_id: string;
    readonly base_url: string;
}
export interface SessionMenuItem {
    readonly id: string;
    readonly label: string;
    readonly path: string | null;
    readonly children: readonly SessionMenuItem[];
}
export interface ApplicationSessionPort {
    epoch(): number;
    connected(): boolean;
    establish(producer: SessionProducer, result: unknown, epoch: number): string;
    complete(stageId: string, producer: SessionProducer, result: unknown, epoch: number): string;
}
export const APPLICATION_SESSION = new InjectionToken<ApplicationSessionPort>('Application session');
export const SESSION_ENDPOINTS = new InjectionToken<readonly SessionEndpoint[]>('Session endpoint bindings', { factory: () => Object.freeze([]) });
// Clé de la session gardée dans l'onglet (cadrage § 22) : fournie par la COQUE,
// seule à porter le préfixe du produit. Sans fournisseur, la session vit en
// mémoire pour ce document.
export const SESSION_STORAGE_KEY = new InjectionToken<string | null>('Session tab storage key', { factory: () => null });
`;
}

export function renderSessionProjection() {
    return `import type { SessionConfiguration, SessionMenuItem, SessionRoute, SessionStage } from './session.types';

export class SessionFailure extends Error {
    constructor(readonly code: 'SESSION_REQUIRED' | 'SESSION_CHANGED' | 'SESSION_RESULT' | 'SESSION_ENDPOINT') {
        super('La session ne peut pas être utilisée.'); this.name = 'SessionFailure';
    }
}
export function own(value: unknown, key: string): unknown {
    if (!value || typeof value !== 'object') return undefined;
    const entry = Object.getOwnPropertyDescriptor(value, key);
    if (!entry) return undefined;
    if (!Object.hasOwn(entry, 'value') || !entry.enumerable) throw new SessionFailure('SESSION_RESULT');
    return entry.value;
}
export function pointer(value: unknown, path: string): unknown {
    if (path.length > 256 || (path && !path.startsWith('/')) || /~(?:[^01]|$)/.test(path)) throw new SessionFailure('SESSION_RESULT');
    let current = value;
    if (!path) return current;
    for (const token of path.slice(1).split('/')) {
        const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
        if (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
        current = own(current, key);
    }
    return current;
}
export function canonicalPath(value: unknown): string | null {
    return typeof value === 'string' && value.length <= 512 &&
        (value === '/' || /^\\/(?:[A-Za-z0-9_-]+\\/)*[A-Za-z0-9_-]+$/.test(value)) &&
        value.split('/').length <= 33 ? value : null;
}
export function snapshot(value: unknown): unknown {
    let nodes = 32768;
    const ancestors = new WeakSet<object>();
    function clone(current: unknown, depth: number): unknown {
        if (--nodes < 0 || depth > 32) throw new SessionFailure('SESSION_RESULT');
        if (current === null || typeof current === 'boolean' || (typeof current === 'number' && Number.isFinite(current))) return current;
        if (typeof current === 'string' && current.length <= 8192) return current;
        if (!current || typeof current !== 'object' || ancestors.has(current)) throw new SessionFailure('SESSION_RESULT');
        const array = Array.isArray(current);
        if (array && Object.getPrototypeOf(current) !== Array.prototype) throw new SessionFailure('SESSION_RESULT');
        if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(current))) throw new SessionFailure('SESSION_RESULT');
        const keys = Reflect.ownKeys(current);
        if ((array && current.length > 2048) || (!array && keys.length > 160) ||
            keys.some((key) => typeof key !== 'string' || key.length > 256)) throw new SessionFailure('SESSION_RESULT');
        ancestors.add(current);
        try {
            if (Array.isArray(current)) {
                if (keys.length !== current.length + 1) throw new SessionFailure('SESSION_RESULT');
                const items: unknown[] = [];
                for (let index = 0; index < current.length; index++) {
                    const item = own(current, String(index));
                    if (item === undefined) throw new SessionFailure('SESSION_RESULT');
                    items.push(clone(item, depth + 1));
                }
                return Object.freeze(items);
            }
            const result: Record<string, unknown> = Object.create(null);
            for (const key of Object.keys(current)) Object.defineProperty(result, key, { value: clone(own(current, key), depth + 1), enumerable: true });
            if (Object.keys(current).length !== keys.length) throw new SessionFailure('SESSION_RESULT');
            return Object.freeze(result);
        } finally { ancestors.delete(current); }
    }
    return clone(value, 0);
}
export function stringList(value: unknown): readonly string[] {
    if (!Array.isArray(value) || value.length > 2048 || value.some((entry: unknown) => typeof entry !== 'string' || entry.length > 512))
        throw new SessionFailure('SESSION_RESULT');
    return Object.freeze(value.map((entry: unknown) => {
        if (typeof entry !== 'string') throw new SessionFailure('SESSION_RESULT');
        return entry;
    }));
}
export function routePermitted(route: SessionRoute, permissions: readonly string[]): boolean {
    return route.access.mode !== 'authorized' || route.access.permissions.every((permission) => permissions.includes(permission));
}
export function sessionMenu(value: unknown, paths: readonly string[], permissions: readonly string[], config: SessionConfiguration): readonly SessionMenuItem[] {
    const available: ReadonlySet<string> = new Set<string>(config.routes.filter((route) => route.access.mode !== 'public' &&
        !config.stages.some((stage) => stage.page_id === route.page_id) && routePermitted(route, permissions)).map((route) => route.path));
    const allowed: ReadonlySet<string> = new Set<string>(paths.filter((path) => canonicalPath(path) && available.has(path)));
    let remaining = 512;
    function visit(items: unknown, depth: number, prefix: string): readonly SessionMenuItem[] {
        if (items === undefined || items === null) return Object.freeze([]);
        if (!Array.isArray(items) || items.length > 128 || depth > 32) throw new SessionFailure('SESSION_RESULT');
        const menu: SessionMenuItem[] = [];
        for (const [index, item] of items.entries()) {
            if (--remaining < 0) throw new SessionFailure('SESSION_RESULT');
            const label = pointer(item, config.menu.label_pointer);
            if (typeof label !== 'string' || !label.trim() || label.length > 160) throw new SessionFailure('SESSION_RESULT');
            const id = prefix + '-' + index;
            const children: readonly SessionMenuItem[] = config.menu.children_pointer === undefined ? Object.freeze([]) : visit(pointer(item, config.menu.children_pointer), depth + 1, id);
            const candidate = canonicalPath(pointer(item, config.menu.path_pointer));
            const path = candidate && allowed.has(candidate) ? candidate : null;
            if (path || children.length) menu.push(Object.freeze({ id, label: label.replace(/[\\u0000-\\u001f\\u007f]/g, ' '), path, children }));
        }
        return Object.freeze(menu);
    }
    return visit(value, 0, 'item');
}
${renderTabSessionProjection()}`;
}

function sessionStore(config, appName) {
    return `import { DOCUMENT } from '@angular/common';
import { computed, inject, Service, signal } from '@angular/core';
import type { HttpRequest } from '@angular/common/http';
import { SESSION_ENDPOINTS, SESSION_STORAGE_KEY, type ApplicationSessionPort, type SessionConfiguration, type SessionProducer, type SessionMenuItem } from './session.types';
import { pendingStage, pointer, projectSession, snapshot, sessionMenu, routePermitted, restoreTabSession, serializeTabSession, staleTabSessionKeys,
    SessionFailure, TAB_SESSION_MAX_CHARS, type TabSession } from './session.projection';

export const SESSION_CONFIGURATION: SessionConfiguration = ${JSON.stringify(config)};
// Empreinte de la configuration rendue (V3.7.10) : une session gardée sous
// une autre configuration (étapes, pointeurs, protocole) est effacée.
export const SESSION_CONFIGURATION_SHA256 = ${JSON.stringify(sha256(stableStringify(config)))};
const SESSION_APP = ${JSON.stringify(appName)};
function sameProducer(left: SessionProducer, right: SessionProducer): boolean {
    return left.page_id === right.page_id && left.action_id === right.action_id &&
        left.response_status === right.response_status && left.result_model_id === right.result_model_id;
}
// Stockage de session de l'onglet, ou rien : indisponible (SecurityError quand
// la persistance est bloquée), la session vit en mémoire pour ce document.
function tabStorage(view: (Window & typeof globalThis) | null): Storage | null {
    try { return view?.sessionStorage ?? null; } catch { return null; }
}
@Service({ autoProvided: true })
export class ApplicationSession implements ApplicationSessionPort {
    private readonly endpoints = inject(SESSION_ENDPOINTS);
    private readonly key = inject(SESSION_STORAGE_KEY);
    private readonly view = inject(DOCUMENT).defaultView;
    private readonly storage = this.key === null ? null : tabStorage(this.view);
    private readonly state = signal<TabSession | null>(null);
    private readonly generation = signal(0);
    readonly epoch = this.generation.asReadonly();
    readonly connected = computed(() => this.state() !== null);
    readonly stage = computed(() => {
        const session = this.state();
        return session ? pendingStage(session, SESSION_CONFIGURATION) : null;
    });
    readonly menu = computed<readonly SessionMenuItem[]>(() => {
        const state = this.state();
        return !state || this.stage() ? Object.freeze([]) : sessionMenu(state.menu, state.paths, state.permissions, SESSION_CONFIGURATION);
    });
    // Reprise SYNCHRONE, avant la première décision de route : le service naît
    // à sa première injection, par la garde de la navigation initiale.
    constructor() {
        const restored = this.restore();
        if (restored) this.state.set(restored);
    }
    private restore(): TabSession | null {
        const storage = this.storage;
        const key = this.key;
        if (!storage || key === null) return null;
        try {
            for (const stale of staleTabSessionKeys(Array.from({ length: storage.length }, (_, index) => storage.key(index)), key, SESSION_APP))
                storage.removeItem(stale);
            // Copie de l'onglet ouvreur (norme HTML) : effacée, jamais reprise.
            if (this.view?.opener !== null) {
                storage.removeItem(key);
                return null;
            }
            const raw = storage.getItem(key);
            if (raw === null) return null;
            try {
                return restoreTabSession(raw, SESSION_APP, SESSION_CONFIGURATION_SHA256, SESSION_CONFIGURATION);
            } catch {
                storage.removeItem(key);
                return null;
            }
        } catch {
            return null;
        }
    }
    private persist(session: TabSession): void {
        const storage = this.storage;
        if (!storage || this.key === null) return;
        try {
            const value = serializeTabSession(session, SESSION_APP, SESSION_CONFIGURATION_SHA256);
            if (value.length > TAB_SESSION_MAX_CHARS) storage.removeItem(this.key);
            else storage.setItem(this.key, value);
        } catch {
            this.forget();
        }
    }
    private forget(): void {
        try {
            if (this.storage && this.key !== null) this.storage.removeItem(this.key);
        } catch {
            // Stockage indisponible : rien n'est gardé.
        }
    }
    path(pageId: string): string {
        const route = SESSION_CONFIGURATION.routes.find((entry) => entry.page_id === pageId);
        if (!route) throw new SessionFailure('SESSION_RESULT');
        return route.path;
    }
    nextPath(): string { return this.path(!this.connected() ? SESSION_CONFIGURATION.reconnect_page_id : this.stage()?.page_id ?? SESSION_CONFIGURATION.landing_page_id); }
    establish(producer: SessionProducer, result: unknown, epoch: number): string {
        if (epoch !== this.epoch()) throw new SessionFailure('SESSION_CHANGED');
        if (!sameProducer(producer, SESSION_CONFIGURATION.producer)) throw new SessionFailure('SESSION_RESULT');
        const session = projectSession(snapshot(result), SESSION_CONFIGURATION);
        this.generation.update((value) => value + 1);
        this.state.set(session);
        this.persist(session);
        return this.nextPath();
    }
    complete(stageId: string, producer: SessionProducer, result: unknown, epoch: number): string {
        if (epoch !== this.epoch()) throw new SessionFailure('SESSION_CHANGED');
        const state = this.state();
        const stage = this.stage();
        if (!state || !stage || stage.id !== stageId || !sameProducer(producer, stage.completion.producer)) throw new SessionFailure('SESSION_RESULT');
        const condition = stage.completion.result_condition;
        if (condition && pointer(snapshot(result), condition.pointer) !== condition.equals) throw new SessionFailure('SESSION_RESULT');
        if (stage.completion.effect === 'clear-and-reconnect') this.clear(epoch);
        else {
            const next: TabSession = Object.freeze({ ...state, acknowledged: new Set<string>([...state.acknowledged, stageId]) });
            this.generation.update((value) => value + 1);
            this.state.set(next);
            this.persist(next);
        }
        return this.nextPath();
    }
    // Déconnexion, 401, effet clear-and-reconnect : la clé de l'onglet est
    // effacée, PUIS l'état.
    clear(epoch = this.epoch()): boolean {
        if (epoch !== this.epoch()) return false;
        const wasConnected = this.connected();
        this.forget();
        this.generation.update((value) => value + 1);
        this.state.set(null);
        return wasConnected;
    }
    destination(pageId: string): string | null {
        const route = SESSION_CONFIGURATION.routes.find((entry) => entry.page_id === pageId);
        if (!route) return this.nextPath();
        if (route.access.mode === 'public') return this.connected() ? this.nextPath() : null;
        if (!this.connected()) return this.nextPath();
        const stage = this.stage();
        if (stage) return pageId === stage.page_id ? null : this.path(stage.page_id);
        if (pageId === SESSION_CONFIGURATION.landing_page_id) return null;
        const state = this.state();
        return state && state.paths.includes(route.path) && routePermitted(route, state.permissions) ? null : this.nextPath();
    }
    authorize<T>(request: HttpRequest<T>): HttpRequest<T> | null {
        // Chemin BRUT anormal, avant toute normalisation (CI #389, frontière du
        // Bearer) : %, \\ ou segment . ou .. ne reçoivent jamais le Bearer, même
        // s'ils se normalisent vers un chemin déclaré. L'analyseur d'URL décode
        // %2e%2e en .. et le retire : le contrôle doit précéder new URL.
        const rawPath = request.url.split(/[?#]/)[0];
        if (/[%\\\\]/.test(rawPath) || /(?:^|\\/)\\.\\.?(?:\\/|$)/.test(rawPath)) return null;
        const matches = SESSION_CONFIGURATION.protected_operations.filter((operation) => {
            if (operation.method !== request.method) return false;
            const endpoints = this.endpoints.filter((endpoint) => endpoint.contract_id === operation.contract_id && endpoint.service_id === operation.service_id);
            if (endpoints.length !== 1) return false;
            try {
                const base = new URL(endpoints[0].base_url);
                const url = new URL(request.url, base.origin);
                if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash ||
                    /[%\\\\]/.test(base.pathname) || url.username || url.password || url.hash || /[%\\\\]/.test(url.pathname)) return false;
                const path = base.pathname.replace(/\\/$/, '') + operation.path;
                return url.origin === base.origin && url.pathname === path;
            } catch { return false; }
        });
        if (matches.length !== 1) return null;
        const token = this.state()?.token;
        if (!token) throw new SessionFailure('SESSION_REQUIRED');
        return request.clone({ setHeaders: { Authorization: 'Bearer ' + token }, cache: 'no-store', redirect: 'error', credentials: 'omit', transferCache: false });
    }
}
`;
}

function sessionHttp() {
    return `import { inject } from '@angular/core';
import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { Router } from '@angular/router';
import { SKIP_AUTH } from './auth-context.token';
import { catchError, map, throwError } from 'rxjs';
import { ApplicationSession } from './session.store';
import { SessionFailure } from './session.projection';

export const applicationSessionInterceptor: HttpInterceptorFn = (request, next) => {
    const session = inject(ApplicationSession);
    const router = inject(Router);
    if (request.context.get(SKIP_AUTH)) return next(request.clone({ cache: 'no-store', redirect: 'error', credentials: 'omit', transferCache: false }));
    const protectedRequest = session.authorize(request);
    if (!protectedRequest) return next(request);
    const epoch = session.epoch();
    return next(protectedRequest).pipe(
        map((event) => {
            if (session.epoch() !== epoch) throw new SessionFailure('SESSION_CHANGED');
            return event;
        }),
        catchError((error: unknown) => {
            if (session.epoch() !== epoch) return throwError(() => new SessionFailure('SESSION_CHANGED'));
            if (error instanceof HttpErrorResponse && error.status === 401 && session.clear(epoch))
                void router.navigateByUrl(session.nextPath(), { replaceUrl: true });
            return throwError(() => error);
        })
    );
};
`;
}

function sessionGuard() {
    return `import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { ApplicationSession } from './session.store';

export const applicationSessionGuard: CanActivateFn = (route) => {
    const session = inject(ApplicationSession);
    const router = inject(Router);
    const pageId: unknown = route.data['page_id'];
    const destination = typeof pageId === 'string' ? session.destination(pageId) : session.nextPath();
    return destination === null ? true : router.parseUrl(destination);
};
`;
}

function navigationComponent() {
    return `import { ChangeDetectionStrategy, Component, forwardRef, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import type { SessionMenuItem } from './session.types';

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: 'app-session-menu',
    imports: [RouterLink, RouterLinkActive, forwardRef(() => ApplicationSessionMenu)],
    template: \`<ul>
        @for (item of items(); track item.id) {
            <li>
                @if (item.children.length) {
                    <details><summary>{{ item.label }}</summary>
                        @if (item.path) { <a [routerLink]="item.path" routerLinkActive="active" ariaCurrentWhenActive="page">{{ item.label }}</a> }
                        <app-session-menu [items]="item.children" />
                    </details>
                } @else if (item.path) {
                    <a [routerLink]="item.path" routerLinkActive="active" ariaCurrentWhenActive="page">{{ item.label }}</a>
                }
            </li>
        }
    </ul>\`,
    styles: \`ul { list-style: none; padding-inline-start: .75rem; margin: 0; }
        a, summary { display: block; padding: .75rem; overflow-wrap: anywhere; }
        summary { cursor: pointer; } .active { font-weight: 700; }
        :focus-visible { outline: 3px solid #005fcc; outline-offset: 2px; }\`,
})
export class ApplicationSessionMenu { readonly items = input.required<readonly SessionMenuItem[]>(); }
`;
}

export function renderAngularSessionPortTypes() {
    return sessionTypes();
}

export const sessionEndpointToken = (serviceId) =>
    serviceId.replace(/[._-]/g, '_').toUpperCase() + '_API_URL';

export async function renderSessionHostSupport() {
    const files = { 'session.types.ts': sessionTypes() };
    for (const [target, source] of Object.entries(SESSION_NATIVE_SOURCES))
        files[target] = await readFile(
            new URL('../../../' + source, import.meta.url),
            'utf8'
        );
    files['index.ts'] = `export * from './session.types';
export * from './auth-context.token';
export * from './action-request-request-context';
export * from './cache-context.token';
export * from './list-query-request-context';
export * from './native-errors/http/invalid-payload.error';
export * from './native-errors/http/server-response.error';
`;
    return files;
}

// Services de la session : identifiant → contrat, sans collision de nom de
// jeton. Source des jetons de service et, en extérieur, du relais (X4-config).
export function sessionServices(config) {
    const services = new Map();
    for (const operation of config.protected_operations) {
        const previous = services.get(operation.service_id);
        if (previous && previous !== operation.contract_id)
            throw new Error('APP_SESSION_ENDPOINT_COLLISION');
        services.set(operation.service_id, operation.contract_id);
    }
    if (
        new Set([...services.keys()].map(sessionEndpointToken)).size !==
        services.size
    )
        throw new Error('APP_SESSION_ENDPOINT_COLLISION');
    return services;
}

export function renderSessionEndpointTokens(config) {
    const services = sessionServices(config);
    return `import { InjectionToken, inject } from '@angular/core';
import { SESSION_ENDPOINTS } from './session.types';
import { SessionFailure } from './session.projection';
${[...services]
    .map(
        ([
            serviceId,
            contractId,
        ]) => `export const ${sessionEndpointToken(serviceId)} = new InjectionToken<string>(${JSON.stringify(serviceId)}, {
    factory: () => {
        const endpoints = inject(SESSION_ENDPOINTS).filter((endpoint) => endpoint.contract_id === ${JSON.stringify(contractId)} && endpoint.service_id === ${JSON.stringify(serviceId)});
        if (endpoints.length !== 1) throw new SessionFailure('SESSION_ENDPOINT');
        const raw = endpoints[0].base_url;
        if (typeof raw !== 'string' || raw !== raw.trim() || /\\s|[%\\\\]/.test(raw) || /(?:^|\\/)\\.\\.?(?:\\/|$)/.test(raw)) throw new SessionFailure('SESSION_ENDPOINT');
        let url: URL;
        try { url = new URL(raw); } catch { throw new SessionFailure('SESSION_ENDPOINT'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new SessionFailure('SESSION_ENDPOINT');
        return url.href.replace(/\\/$/, '');
    },
});`
    )
    .join('\n')}
`;
}

// Spécifieurs des modules de session vus de la coque. Mode interne : le
// dossier de session de l'appli. Lot 2, mode extérieur (`layout`) : l'API
// publique du socle et l'entrée réservée à la coque (V3.7.10).
function sessionImports(layout) {
    return layout
        ? {
              store: `import { ApplicationSession } from '${layout.socle}';\nimport { SESSION_CONFIGURATION } from '${layout.coque}';`,
              menu: `import { ApplicationSessionMenu } from '${layout.socle}';`,
              guard: `import { applicationSessionGuard } from '${layout.coque}';`,
          }
        : {
              store: "import { ApplicationSession, SESSION_CONFIGURATION } from './session/session.store';",
              menu: "import { ApplicationSessionMenu } from './session/session-menu';",
              guard: "import { applicationSessionGuard } from './session/session.guard';",
          };
}

// Chargement paresseux d'une page : son module dans l'appli (mode interne),
// ou la carte des pages de l'interface (lot 2, V5.1 règle 6).
export const angularPageLoader = (pageId, layout) =>
    layout
        ? `() => import('${layout.pages}').then((module) => module.pages.${pageId}())`
        : `() => import('./pages/${pageId}/page.component').then((module) => module.PageComponent)`;

function sessionApp(design, layout) {
    const imports = sessionImports(layout);
    return `import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, Injector, afterNextRender, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
${imports.store}
${imports.menu}

@Component({
    selector: 'app-root', changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [RouterOutlet, ApplicationSessionMenu],
    template: \`<a class="skip" href="#app-main">Aller au contenu</a>
        <header><span>{{ title }}</span>
            @if (session.connected()) {
                <button id="navigation-toggle" type="button" aria-controls="application-navigation" [attr.aria-expanded]="menuOpen()" (click)="menuOpen.set(!menuOpen())">Navigation</button>
                <button type="button" (click)="logout()">{{ logoutLabel }}</button>
            }
        </header>
        <div class="layout" [class.authenticated]="session.connected()">
            @if (session.connected()) {
                <nav id="application-navigation" tabindex="-1" aria-label="Navigation principale" [class.is-open]="menuOpen()" (keydown.escape)="closeMenu()">
                    <app-session-menu [items]="session.menu()" />
                </nav>
            }
            <main id="app-main" tabindex="-1"><router-outlet /></main>
        </div>\`,
    styles: \`:host { display: block; min-inline-size: 0; }
        .skip { position: absolute; inset-inline-start: .5rem; inset-block-start: -5rem; z-index: 2; background: white; padding: .75rem; }
        .skip:focus { inset-block-start: .5rem; }
        header { display: flex; align-items: center; flex-wrap: wrap; gap: .75rem; padding: 1rem; border-block-end: 1px solid #ccc; }
        header span { flex: 1; overflow-wrap: anywhere; }
        button { min-block-size: 44px; padding: .5rem .75rem; }
        .layout { display: grid; grid-template-columns: minmax(0, 1fr); }
        nav { display: none; padding: .5rem; border-block-end: 1px solid #ccc; overflow-wrap: anywhere; }
        nav.is-open { display: block; }
        main { min-inline-size: 0; padding: clamp(.75rem, 2vw, 2rem); }
        :focus-visible { outline: 3px solid #005fcc; outline-offset: 3px; }
        @media (min-width: 48rem) {
            .layout.authenticated { grid-template-columns: minmax(12rem, 18rem) minmax(0, 1fr); }
            nav { display: block; border-inline-end: 1px solid #ccc; border-block-end: 0; }
            #navigation-toggle { display: none; }
        }\`,
})
export class App {
    readonly session = inject(ApplicationSession);
    readonly menuOpen = signal(false);
    readonly title = ${JSON.stringify(design.design.title)};
    readonly logoutLabel = SESSION_CONFIGURATION.logout_label;
    private readonly router = inject(Router);
    private readonly document = inject(DOCUMENT);
    private readonly injector = inject(Injector);
    constructor() {
        this.router.events.pipe(filter((event) => event instanceof NavigationEnd), takeUntilDestroyed()).subscribe(() => {
            this.menuOpen.set(false);
            afterNextRender(() => this.document.getElementById('app-main')?.focus(), { injector: this.injector });
        });
    }
    closeMenu(): void {
        if (!this.menuOpen()) return;
        this.menuOpen.set(false);
        this.document.getElementById('navigation-toggle')?.focus();
    }
    logout(): void { this.session.clear(); void this.router.navigateByUrl(this.session.nextPath(), { replaceUrl: true }); }
}
`;
}

function sessionRoutes(config, layout) {
    return `import type { Routes } from '@angular/router';
${sessionImports(layout).guard}

export const appRoutes: Routes = [
${config.routes.map((route) => `    { path: ${JSON.stringify(route.path === '/' ? '' : route.path.slice(1))}, data: { page_id: ${JSON.stringify(route.page_id)} }, canActivate: [applicationSessionGuard], loadComponent: ${angularPageLoader(route.page_id, layout)} },`).join('\n')}
    { path: '**', redirectTo: ${JSON.stringify(config.routes.find((route) => route.page_id === config.reconnect_page_id).path)} },
];
`;
}

function sessionWorker(prefix) {
    return `const CACHE = '${productForms(prefix).kebab}session-static-v1';
const STATIC = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', (event) => { event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(STATIC))); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || url.search || !STATIC.includes(url.pathname)) return;
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
`;
}

// Mode extérieur seulement : `create-app --target-root` exige que la cible
// native `test` du produit exécute au moins un test. La coque avec session
// retire `access.guard.spec.ts` ; ce test prouve sa garde sans session.
export function renderExternalSessionGuardSpec() {
    return `import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree, type ActivatedRouteSnapshot, type RouterStateSnapshot } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { applicationSessionGuard } from './session.guard';
import { ApplicationSession, SESSION_CONFIGURATION } from './session.store';

function decide(pageId: unknown): unknown {
    const route = { data: { page_id: pageId } } as unknown as ActivatedRouteSnapshot;
    return TestBed.runInInjectionContext(() => applicationSessionGuard(route, {} as RouterStateSnapshot));
}

describe('applicationSessionGuard sans session', () => {
    beforeEach(() => {
        TestBed.configureTestingModule({ providers: [provideRouter([])] });
    });

    it('laisse ouvertes les pages publiques déclarées', () => {
        for (const route of SESSION_CONFIGURATION.routes.filter((entry) => entry.access.mode === 'public')) {
            expect(decide(route.page_id)).toBe(true);
        }
    });

    it('redirige chaque page non publique et toute donnée de route inconnue vers la reconnexion', () => {
        const session = TestBed.inject(ApplicationSession);
        const router = TestBed.inject(Router);
        const reconnect = session.path(SESSION_CONFIGURATION.reconnect_page_id);
        expect(session.connected()).toBe(false);
        const guarded = SESSION_CONFIGURATION.routes.filter((entry) => entry.access.mode !== 'public');
        expect(guarded.length).toBeGreaterThan(0);
        for (const pageId of [...guarded.map((entry) => entry.page_id), undefined, 'page-absente']) {
            const decision = decide(pageId);
            expect(decision).toBeInstanceOf(UrlTree);
            expect(router.serializeUrl(decision as UrlTree)).toBe(reconnect);
        }
    });
});
`;
}

// `layout` (lot 2, mode extérieur seulement) : spécifieurs du socle, de
// l'entrée de la coque et de la carte des pages ; absent, le mode interne
// garde sa disposition à une racine.
// Clé de la session de l'onglet (V3.7.2) : une forme du préfixe, rendue par la
// COQUE seule (famille « clé de session de l'onglet » de MARQUE).
export const tabSessionKey = (prefix, appName) =>
    `${productForms(prefix).kebab}session-v1:${appName}`;

export async function renderAngularApplicationSession({
    design,
    experience,
    prefix,
    appName,
    layout,
}) {
    if (typeof appName !== 'string' || !appName)
        throw new Error('APP_SESSION_APP_NAME');
    const config = sessionRenderConfiguration(design, experience);
    const key = JSON.stringify(tabSessionKey(prefix, appName));
    const support = await renderSessionHostSupport();
    return {
        ...Object.fromEntries(
            Object.entries(support).map(([path, content]) => [
                'src/app/session/' + path,
                content,
            ])
        ),
        'src/app/session/session.types.ts': sessionTypes(),
        'src/app/session/session.projection.ts': renderSessionProjection(),
        'src/app/session/session.store.ts': sessionStore(config, appName),
        'src/app/session/session.interceptor.ts': sessionHttp(),
        'src/app/session/session.guard.ts': sessionGuard(),
        'src/app/session/session-menu.ts': navigationComponent(),
        'src/app/session/service-endpoints.ts':
            renderSessionEndpointTokens(config),
        'src/app/app.ts': sessionApp(design, layout),
        'src/app/app.routes.ts': sessionRoutes(config, layout),
        'src/app/app.config.ts': layout
            ? `import { provideBrowserGlobalErrorListeners, type ApplicationConfig } from '@angular/core';
import { provideRouter } from '@angular/router';
import { SESSION_STORAGE_KEY, provideSocle } from '${layout.coque}';
import { appRoutes } from './app.routes';

export const appConfig: ApplicationConfig = { providers: [provideBrowserGlobalErrorListeners(), provideSocle(), { provide: SESSION_STORAGE_KEY, useValue: ${key} }, provideRouter(appRoutes)] };
`
            : `import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideBrowserGlobalErrorListeners, type ApplicationConfig } from '@angular/core';
import { provideRouter } from '@angular/router';
import { appRoutes } from './app.routes';
import { ApplicationSession } from './session/session.store';
import { APPLICATION_SESSION, SESSION_STORAGE_KEY } from './session/session.types';
import { applicationSessionInterceptor } from './session/session.interceptor';

export const appConfig: ApplicationConfig = { providers: [provideBrowserGlobalErrorListeners(), provideHttpClient(withInterceptors([applicationSessionInterceptor])), provideRouter(appRoutes), { provide: APPLICATION_SESSION, useExisting: ApplicationSession }, { provide: SESSION_STORAGE_KEY, useValue: ${key} }] };
`,
        'public/sw.js': sessionWorker(prefix),
        'src/app/session/index.ts':
            support['index.ts'] +
            "export * from './session.store';\nexport * from './session.projection';\nexport * from './service-endpoints';\n",
    };
}
