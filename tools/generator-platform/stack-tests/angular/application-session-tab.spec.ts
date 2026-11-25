// Lot 2, commit 4 : session gardée dans l'onglet (cadrage § 22 ; conception
// v3 V3.7, v4 V4.7), magasin Angular RÉEL sous jsdom. Une remise à zéro du
// banc de test, puis un nouvel injecteur, joue un rechargement de la page : le
// service de session renaît et relit le stockage de session de l'onglet.
import {
    HttpClient,
    provideHttpClient,
    withInterceptors,
} from '@angular/common/http';
import {
    HttpTestingController,
    provideHttpClientTesting,
} from '@angular/common/http/testing';
import { type ProviderToken } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as observatory from '../../.stack-test-runtime/angular/application-session/observatory/fixture-runtime';
import * as equipment from '../../.stack-test-runtime/angular/application-session/equipment-hire/fixture-runtime';

const FIELDS = [
    'acknowledged',
    'app',
    'config',
    'menu',
    'paths',
    'permissions',
    'stages',
    'token',
    'v',
];

type SessionPort = Pick<
    observatory.ApplicationSession,
    keyof observatory.ApplicationSession
>;
const runtimes: readonly {
    readonly runtime: typeof observatory | typeof equipment;
    readonly sessionToken: ProviderToken<SessionPort>;
}[] = [
    { runtime: observatory, sessionToken: observatory.ApplicationSession },
    { runtime: equipment, sessionToken: equipment.ApplicationSession },
];

for (const { runtime, sessionToken } of runtimes) {
    const domain = runtime.fixture.domain;
    // Clé de la forme que la coque fournit (`<p>-session-v1:<appli>`).
    const key = `qz-session-v1:${domain}`;
    describe(`session gardée dans l'onglet (jsdom) : ${domain}`, () => {
        function configure(storageKey: string | null = key) {
            TestBed.configureTestingModule({
                providers: [
                    provideHttpClient(
                        withInterceptors([
                            runtime.applicationSessionInterceptor,
                        ])
                    ),
                    provideHttpClientTesting(),
                    provideRouter(runtime.consumedRoutes),
                    {
                        provide: runtime.SESSION_ENDPOINTS,
                        useValue: [runtime.fixture.endpoint],
                    },
                    ...(storageKey === null
                        ? []
                        : [
                              {
                                  provide: runtime.SESSION_STORAGE_KEY,
                                  useValue: storageKey,
                              },
                          ]),
                ],
            });
            return {
                session: TestBed.inject(sessionToken),
                http: TestBed.inject(HttpTestingController),
                client: TestBed.inject(HttpClient),
            };
        }
        // Rechargement : un document neuf, un service neuf.
        function reload() {
            TestBed.resetTestingModule();
            return configure();
        }
        function open(session: SessionPort) {
            return session.establish(
                runtime.SESSION_CONFIGURATION.producer,
                runtime.fixture.sessionResult,
                session.epoch()
            );
        }
        // Un navigateur rend `window.opener` NUL sans ouvreur ; jsdom ne le
        // définit pas (`undefined`, mesuré), que la garde stricte
        // `opener !== null` traite comme une copie (échec fermé). Le banc
        // pose donc la valeur d'un navigateur.
        beforeEach(() => {
            window.sessionStorage.clear();
            Object.defineProperty(window, 'opener', {
                configurable: true,
                writable: true,
                value: null,
            });
        });
        afterEach(() => {
            TestBed.resetTestingModule();
            window.sessionStorage.clear();
            Reflect.deleteProperty(window, 'opener');
            vi.restoreAllMocks();
        });

        it('F5 : la projection est reprise avant toute décision de route, la même page et le même menu', () => {
            let { session } = configure();
            const path = open(session);
            const raw = window.sessionStorage.getItem(key);
            expect(raw).not.toBeNull();
            const stored = JSON.parse(String(raw)) as Record<string, unknown>;
            expect(Object.keys(stored).sort()).toEqual(FIELDS);
            expect(stored['v']).toBe(1);
            expect(stored['app']).toBe(domain);
            expect(stored['config']).toBe(runtime.SESSION_CONFIGURATION_SHA256);
            expect(stored['token']).toBe('fixture-token-value');
            const menu = session.menu();
            ({ session } = reload());
            expect(session.connected()).toBe(true);
            expect(session.nextPath()).toBe(path);
            expect(session.menu()).toEqual(menu);
        });

        it('étape : franchie, elle le reste au F5 ; « clear-and-reconnect » efface la clé', () => {
            let { session } = configure();
            open(session);
            const stage = session.stage();
            if (!stage) throw new Error('étape en cours attendue');
            const next = session.complete(
                stage.id,
                stage.completion.producer,
                runtime.fixture.commandResult,
                session.epoch()
            );
            if (stage.completion.effect === 'acknowledge') {
                ({ session } = reload());
                expect(session.connected()).toBe(true);
                expect(session.stage()?.id).not.toBe(stage.id);
                expect(session.nextPath()).toBe(next);
            } else {
                expect(window.sessionStorage.getItem(key)).toBeNull();
                ({ session } = reload());
                expect(session.connected()).toBe(false);
            }
        });

        it('déconnexion puis 401 : la clé est effacée, puis l’état', async () => {
            const { session, http, client } = configure();
            open(session);
            session.clear();
            expect(window.sessionStorage.getItem(key)).toBeNull();
            open(session);
            expect(window.sessionStorage.getItem(key)).not.toBeNull();
            const url =
                runtime.fixture.endpoint.base_url +
                runtime.fixture.operations.catalogue;
            const pending = firstValueFrom(client.get(url));
            http.expectOne(url).flush(
                {},
                { status: 401, statusText: 'Unauthorized' }
            );
            await expect(pending).rejects.toThrow();
            expect(session.connected()).toBe(false);
            expect(window.sessionStorage.getItem(key)).toBeNull();
            http.verify();
        });

        it('copie par un ouvreur : effacée au démarrage, jamais reprise', () => {
            open(configure().session);
            TestBed.resetTestingModule();
            // Un ouvreur, même fermé, reste un objet : la copie est effacée.
            Object.defineProperty(window, 'opener', {
                configurable: true,
                writable: true,
                value: { closed: true },
            });
            const { session } = configure();
            expect(session.connected()).toBe(false);
            expect(window.sessionStorage.getItem(key)).toBeNull();
        });

        it('stockage bloqué : connexion possible, F5 déconnecte, aucune erreur de console', () => {
            const errors = vi.spyOn(console, 'error');
            const descriptor = Object.getOwnPropertyDescriptor(
                window,
                'sessionStorage'
            );
            Object.defineProperty(window, 'sessionStorage', {
                configurable: true,
                get() {
                    throw new DOMException('bloqué', 'SecurityError');
                },
            });
            try {
                let { session } = configure();
                open(session);
                expect(session.connected()).toBe(true);
                ({ session } = reload());
                expect(session.connected()).toBe(false);
            } finally {
                if (descriptor)
                    Object.defineProperty(window, 'sessionStorage', descriptor);
                else Reflect.deleteProperty(window, 'sessionStorage');
            }
            expect(errors).not.toHaveBeenCalled();
            expect(window.sessionStorage.length).toBe(0);
        });

        it('S12 et S13 : clé de la famille sous un autre préfixe, puis configuration différente, effacées', () => {
            window.sessionStorage.setItem(`qx-session-v1:${domain}`, 'reste');
            window.sessionStorage.setItem('qx-session-v1:autre-appli', 'autre');
            const { session } = configure();
            open(session);
            expect(
                window.sessionStorage.getItem(`qx-session-v1:${domain}`)
            ).toBeNull();
            expect(
                window.sessionStorage.getItem('qx-session-v1:autre-appli')
            ).toBe('autre');
            const forged = JSON.parse(
                String(window.sessionStorage.getItem(key))
            ) as Record<string, unknown>;
            forged['config'] = '0'.repeat(64);
            window.sessionStorage.setItem(key, JSON.stringify(forged));
            const { session: reloaded } = reload();
            expect(reloaded.connected()).toBe(false);
            expect(window.sessionStorage.getItem(key)).toBeNull();
        });

        it('sans clé fournie par la coque : la session vit en mémoire seule', () => {
            const { session } = configure(null);
            open(session);
            expect(session.connected()).toBe(true);
            expect(window.sessionStorage.length).toBe(0);
        });
    });
}
