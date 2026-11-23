// X5 C5 (P2, B+) : texte d'absence d'une liaison de données, donnée de la
// CONCEPTION. La composition générée le publie en constante scellée
// (`absentText.<liaison>`) ; la page le lit par ce chemin et ne le recopie
// jamais. Borne : LISTE BLANCHE du diagnostic tiers aveugle (2026-11-12, §6).
// - lettres latines (A–Z, a–z, U+00C0–U+00FF sauf × et ÷, Œ, œ, Ÿ) ;
// - chiffres ; ponctuation `. , ; : ! ? ' ’ ( ) « » … – — / -` ;
// - espace U+0020 seule, entre deux groupes ; au moins une lettre ;
// - 1 à 40 caractères, tous dans le plan de base (unités UTF-16 = points
//   de code).
// Le motif se compile sans drapeau `u`, comme `pattern` dans validate-ir.

export const ABSENT_TEXT_MAX = 40;

const LETTERS =
    'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u00FF\\u0152\\u0153\\u0178';
const ALLOWED = `${LETTERS}0-9.,;:!?'\\u2019()\\u00AB\\u00BB\\u2026\\u2013\\u2014/-`;

// Motif du tiers, à l'identique (sonde probe-charset : 34 cas, 0 échec).
export const ABSENT_TEXT_PATTERN = `^(?=[^${LETTERS}]*[${LETTERS}])[${ALLOWED}]+(?: [${ALLOWED}]+)*$`;

const PATTERN = new RegExp(ABSENT_TEXT_PATTERN);

// Refus nommé, ou undefined si le texte est valide.
export function absentTextError(text) {
    if (typeof text !== 'string')
        return 'PAGE_ABSENT_TEXT_INVALID: absent_text must be a string';
    if (text.length < 1 || text.length > ABSENT_TEXT_MAX)
        return `PAGE_ABSENT_TEXT_INVALID: absent_text must have 1 to ${ABSENT_TEXT_MAX} characters`;
    if (!PATTERN.test(text))
        return 'PAGE_ABSENT_TEXT_INVALID: absent_text must use the allowed letters, digits, punctuation and single inner spaces, with at least one letter';
    return undefined;
}

// Forme d'un texte d'absence déclaré sur une liaison du plan : liaison de
// lecture seulement, texte valide. Refus nommé, ou undefined (texte absent
// compris).
export function absentTextBindingError(binding, kind) {
    if (!Object.hasOwn(binding, 'absent_text')) return undefined;
    if (kind !== 'query')
        return `PAGE_ABSENT_TEXT_INVALID: ${binding.id} absent_text applies to read bindings only`;
    const invalid = absentTextError(binding.absent_text);
    return invalid ? `${binding.id} ${invalid}` : undefined;
}

// Texte d'absence OBLIGATOIRE, garantie du socle vérifiée à la compilation du
// plan : un champ lu qui peut manquer (nullable ou facultatif, d'après le
// modèle de lecture compilé) exige `absent_text` sur chaque liaison de liste
// de sa lecture ; une lecture sans liaison de liste est refusée de même.
// `queryPairs` : lectures de la page résolues par le plan
// (`{ source: { id }, resolved: { operation: { read_model } } }`) ;
// `outputBindings` : liaisons compilées. Premier refus nommé, ou undefined.
export function missingAbsentTextError(queryPairs, outputBindings) {
    const pairs = [...queryPairs].sort((left, right) =>
        left.source.id.localeCompare(right.source.id)
    );
    for (const { source, resolved } of pairs) {
        const absentFields = resolved.operation.read_model.fields
            .filter((field) => field.nullable || !field.required)
            .map((field) => field.name)
            .sort();
        if (absentFields.length === 0) continue;
        const bindings = outputBindings
            .filter(
                (binding) =>
                    binding.producer_node_id === source.id &&
                    binding.output.kind === 'list'
            )
            .sort((left, right) => (left.id < right.id ? -1 : 1));
        const [missing] = bindings.length
            ? bindings.filter(
                  (binding) => !Object.hasOwn(binding, 'absent_text')
              )
            : [{ id: `for ${source.id}` }];
        if (missing)
            return `PAGE_ABSENT_TEXT_MISSING: data binding ${missing.id} needs absent_text for ${absentFields.join(', ')}`;
    }
    return undefined;
}
