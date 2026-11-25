// Lot 2, commit 4 : session gardée dans l'onglet (cadrage § 22 ; conception
// v3 V3.7, v4 V4.7). Fonctions PURES de la projection, rendues à la suite du
// module `session.projection.ts` du socle (même portée : `own`, `pointer`,
// `snapshot`, `stringList`, `sessionMenu`, `SessionFailure`) ; le magasin de
// session les emploie, et l'atelier les éprouve sans Angular.
export function renderTabSessionProjection() {
    return `// Jeton de session : la règle de l'ouverture, une seule source, relue à la
// reprise de l'onglet.
export function sessionToken(value: unknown): string {
    if (typeof value !== 'string' || !value || value.length > 8192 || /\\s|[\\u0000-\\u001f\\u007f]/.test(value)) throw new SessionFailure('SESSION_RESULT');
    return value;
}
// Session gardée dans l'onglet (cadrage § 22) : la PROJECTION exacte de la
// session, jamais la réponse du producteur. Bornée AVANT toute analyse :
// 2 621 440 unités UTF-16, soit les 5 Mio que le navigateur accorde au
// stockage de session d'une origine ; au-delà, rien n'est écrit (mémoire
// seule) et une valeur lue est effacée sans être analysée.
export const TAB_SESSION_VERSION = 1;
export const TAB_SESSION_MAX_CHARS = 2621440;
export const TAB_SESSION_KEY_FAMILY = '-session-v1:';
const TAB_SESSION_FIELDS: readonly string[] = Object.freeze(['acknowledged', 'app', 'config', 'menu', 'paths', 'permissions', 'stages', 'token', 'v']);
export interface TabSession {
    readonly token: string;
    readonly menu: unknown;
    readonly paths: readonly string[];
    readonly permissions: readonly string[];
    readonly stages: Readonly<Record<string, boolean>>;
    readonly acknowledged: ReadonlySet<string>;
}
// Ouverture de session : la projection exacte d'un résultat du producteur déjà
// copié par snapshot (jeton, sujet présent, chemins, permissions, RÉSULTAT de
// chaque prédicat d'étape, menu accepté), jamais la réponse elle-même.
export function projectSession(candidate: unknown, config: SessionConfiguration): TabSession {
    const projection = config.projection;
    const token = sessionToken(pointer(candidate, projection.token_pointer));
    const subject = pointer(candidate, projection.subject_pointer);
    if (!subject || typeof subject !== 'object' || Array.isArray(subject)) throw new SessionFailure('SESSION_RESULT');
    const paths = stringList(pointer(candidate, projection.allowed_paths_pointer));
    const permissions: readonly string[] = projection.permissions_pointer === undefined ? Object.freeze([]) : stringList(pointer(candidate, projection.permissions_pointer));
    const stages: Record<string, boolean> = Object.create(null);
    for (const stage of config.stages) {
        const value = pointer(candidate, stage.predicate.pointer);
        if (value === undefined || (stage.predicate.operator === 'is-true' && typeof value !== 'boolean')) throw new SessionFailure('SESSION_RESULT');
        stages[stage.id] = stage.predicate.operator === 'is-null' ? value === null : value === true;
    }
    const menu = pointer(candidate, projection.menu_pointer) ?? null;
    sessionMenu(menu, paths, permissions, config);
    return Object.freeze({ token, menu, paths, permissions, stages: Object.freeze(stages), acknowledged: new Set<string>() });
}
// Étape en cours, recalculée depuis la projection (attente S2 du lot 4).
export function pendingStage(session: TabSession, config: SessionConfiguration): SessionStage | null {
    return config.stages.find((stage) => !session.acknowledged.has(stage.id) && own(session.stages, stage.id) === true) ?? null;
}
export function serializeTabSession(session: TabSession, app: string, digest: string): string {
    return JSON.stringify({
        v: TAB_SESSION_VERSION, app, token: session.token, menu: session.menu ?? null, paths: session.paths,
        permissions: session.permissions, stages: session.stages, acknowledged: [...session.acknowledged].sort(), config: digest,
    });
}
// Reprise : chaque contrôle échoue fermé (SessionFailure) ; l'appelant efface
// alors la clé. Les étapes sont exactement celles de la configuration
// COURANTE, et l'empreinte de cette configuration doit être la même.
export function restoreTabSession(raw: unknown, app: string, digest: string, config: SessionConfiguration): TabSession {
    if (typeof raw !== 'string' || raw.length > TAB_SESSION_MAX_CHARS) throw new SessionFailure('SESSION_RESULT');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new SessionFailure('SESSION_RESULT'); }
    const value = snapshot(parsed);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SessionFailure('SESSION_RESULT');
    const keys = Object.keys(value).sort();
    if (keys.length !== TAB_SESSION_FIELDS.length || keys.some((key, index) => key !== TAB_SESSION_FIELDS[index])) throw new SessionFailure('SESSION_RESULT');
    if (own(value, 'v') !== TAB_SESSION_VERSION || own(value, 'app') !== app || own(value, 'config') !== digest) throw new SessionFailure('SESSION_RESULT');
    const token = sessionToken(own(value, 'token'));
    const paths = stringList(own(value, 'paths'));
    const permissions = stringList(own(value, 'permissions'));
    const menu = own(value, 'menu');
    sessionMenu(menu, paths, permissions, config);
    const ids = config.stages.map((stage) => stage.id);
    const stages = own(value, 'stages');
    if (!stages || typeof stages !== 'object' || Array.isArray(stages) || Object.keys(stages).length !== ids.length ||
        ids.some((id) => typeof own(stages, id) !== 'boolean')) throw new SessionFailure('SESSION_RESULT');
    const acknowledged = stringList(own(value, 'acknowledged'));
    if (acknowledged.some((id, index) => !ids.includes(id) || (index > 0 && acknowledged[index - 1] >= id))) throw new SessionFailure('SESSION_RESULT');
    return Object.freeze({ token, menu, paths, permissions, stages: stages as Readonly<Record<string, boolean>>, acknowledged: new Set<string>(acknowledged) });
}
// Clés de la même famille pour cette appli, sous un autre préfixe (restes d'un
// renommage du produit) : effacées au démarrage.
export function staleTabSessionKeys(keys: readonly (string | null)[], key: string, app: string): readonly string[] {
    const suffix = TAB_SESSION_KEY_FAMILY + app;
    return Object.freeze(keys.filter((entry): entry is string => typeof entry === 'string' && entry !== key &&
        entry.endsWith(suffix) && /^[a-z][a-z0-9]{1,5}$/.test(entry.slice(0, -suffix.length))));
}
`;
}
