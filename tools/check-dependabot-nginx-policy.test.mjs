// X4-config, NGINX-FRAICHEUR (C2) : entrée Dependabot docker du relais nginx,
// groupée, tous les jours à heure fixe UTC, et fraîcheur quotidienne (b)
// planifiée après elle. Importé par check-dependabot-policy.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';

import {
    NGINX_FRESHNESS_DELAY_MINUTES,
    NGINX_RELAY_DIRECTORY,
    nginxRelayPolicyErrors,
} from './check-dependabot-policy.mjs';
import { NGINX_FRESHNESS_WORKFLOW } from './check-workflow-privileges.mjs';

const read = (path) =>
    parseYaml(readFileSync(new URL(path, import.meta.url), 'utf8'));
const real = read('../.github/dependabot.yml');
const daily = read(`../.github/workflows/${NGINX_FRESHNESS_WORKFLOW}`);
const relay = (config) =>
    config.updates.find((u) => u.directory === NGINX_RELAY_DIRECTORY);
const withRelay = (change) => {
    const config = structuredClone(real);
    change(relay(config));
    return config;
};
const withCron = (cron) => {
    const workflow = structuredClone(daily);
    workflow.on.schedule = [{ cron }];
    return workflow;
};
const at = (cron) => {
    const [minute, hour] = cron.split(' ').map(Number);
    return hour * 60 + minute;
};

test('exige l’entrée docker du relais nginx, groupée, et refuse son absence', () => {
    assert.deepEqual(nginxRelayPolicyErrors(real, daily), []);
    const without = structuredClone(real);
    without.updates = without.updates.filter((u) => u !== relay(without));
    assert.match(
        nginxRelayPolicyErrors(without, daily).join('\n'),
        /attendu exactement un update Dependabot docker pour '\/tools\/generator-platform\/nginx-harness', trouvé 0/
    );
    assert.match(
        nginxRelayPolicyErrors(
            withRelay((u) => delete u.groups),
            daily
        ).join('\n'),
        /le groupe 'nginx-relay' doit couvrir l'image 'nginx'/
    );
});

test('C2 : cron quotidien à heure fixe UTC, et refus de weekly, daily ou monthly', () => {
    assert.equal(relay(real).schedule.interval, 'cron');
    for (const schedule of [
        { interval: 'weekly', day: 'monday' },
        { interval: 'weekly' },
        { interval: 'daily', time: '05:00' },
        { interval: 'monthly' },
        { interval: 'cron' },
        { interval: 'cron', cronjob: '0 5 * * 1', timezone: 'UTC' },
        { interval: 'cron', cronjob: '0 5 * * 1-5', timezone: 'UTC' },
        { interval: 'cron', cronjob: '0 */6 * * *', timezone: 'UTC' },
        { interval: 'cron', cronjob: 'every day at 5am', timezone: 'UTC' },
        { interval: 'cron', cronjob: '0 5 * * *' },
        { interval: 'cron', cronjob: '0 5 * * *', timezone: 'Europe/Paris' },
        // `cronjob` ne vaut que pour `interval: 'cron'` (« Dependabot options
        // reference ») : un cron quotidien ne rachète pas un autre intervalle.
        { interval: 'weekly', cronjob: '0 5 * * *', timezone: 'UTC' },
    ])
        assert.match(
            nginxRelayPolicyErrors(
                withRelay((u) => (u.schedule = schedule)),
                daily
            ).join('\n'),
            /schedule attendu \{ interval: 'cron', cronjob: 'M H \* \* \*', timezone: 'UTC' \}/,
            JSON.stringify(schedule)
        );
});

test('C2 : la fraîcheur (b) passe après Dependabot, avec la marge, un seul cron quotidien', () => {
    const dependabot = relay(real).schedule.cronjob;
    const freshness = daily.on.schedule[0].cron;
    assert.ok(
        at(freshness) - at(dependabot) >= NGINX_FRESHNESS_DELAY_MINUTES,
        `${dependabot} → ${freshness}`
    );
    const late = (minutes) => {
        const total = at(dependabot) + minutes;
        return `${total % 60} ${Math.floor(total / 60)} * * *`;
    };
    assert.deepEqual(
        nginxRelayPolicyErrors(
            real,
            withCron(late(NGINX_FRESHNESS_DELAY_MINUTES))
        ),
        []
    );
    for (const cron of [
        late(NGINX_FRESHNESS_DELAY_MINUTES - 1),
        late(0),
        late(-60),
    ])
        assert.match(
            nginxRelayPolicyErrors(real, withCron(cron)).join('\n'),
            new RegExp(`au moins ${NGINX_FRESHNESS_DELAY_MINUTES} min après`),
            cron
        );
    const twice = structuredClone(daily);
    twice.on.schedule.push({ cron: freshness });
    for (const workflow of [
        twice,
        withCron('17 8 * * 1'),
        { on: { workflow_dispatch: null } },
        undefined,
    ])
        assert.match(
            nginxRelayPolicyErrors(real, workflow).join('\n'),
            /un seul cron quotidien/
        );
});
