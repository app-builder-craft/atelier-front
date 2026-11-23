// Corpus des refus de l'atelier 1 (lot 10) : DONNÉES gardées après le retrait
// de la grammaire, jugées par la preuve de sortie du lot 5 (règles de
// l'interface) et du lot 6 (classes « exécution »). Aucun outil ne les lit
// ici : seul leur test d'intégrité les garde (page-probes.test.mjs). Les
// sondes viennent, à l'octet, des deux modules de l'atelier 1 (voir
// page-probes-validateur-1.mjs et -2.mjs) ; leur classe et leur décision
// sont dans page-probe-classes.mjs.
import { VALIDATOR_PROBES } from './page-probes-validateur-1.mjs';
import { SECOND_PROBES } from './page-probes-validateur-2.mjs';

export { VALIDATOR_PROBES, SECOND_PROBES };

// Les 204 sondes, dans l'ordre d'origine.
export const PAGE_PROBES = Object.freeze([
    ...VALIDATOR_PROBES,
    ...SECOND_PROBES,
]);

// Contre-sondes de la relecture du lot 10 (gabarit : chaînes `$event` ;
// hôte : clés et valeurs de `host`), sans lesquelles aucune sonde n'emploie
// `?.` ni l'accès par clé sous `$event`. Fichier entier, jugé tel quel.
export const COUNTER_PROBES = Object.freeze(
    [
        {
            id: 'gabarit:$event.view.navigation.navigate',
            file: 'p.html',
            text: '<button type="button" (click)="$event.view.navigation.navigate(\'//x.invalid/\')">x</button>\n',
            refused: true,
        },
        {
            id: 'gabarit:composedPath',
            file: 'p.html',
            text: '<button type="button" (click)="$event.composedPath().at(-1).navigation.navigate(\'//x.invalid/\')">x</button>\n',
            refused: true,
        },
        {
            id: 'gabarit:getRootNode',
            file: 'p.html',
            text: '<button type="button" (click)="$event.target.getRootNode().body">x</button>\n',
            refused: true,
        },
        {
            id: 'gabarit:ownerDocument',
            file: 'p.html',
            text: '<button type="button" (click)="$event.target.ownerDocument.defaultView">x</button>\n',
            refused: true,
        },
        {
            id: 'gabarit:safe chaîne entière',
            file: 'p.html',
            text: '<button type="button" (click)="$event?.view?.navigation?.navigate(\'//x.invalid/\')">x</button>\n',
            refused: true,
        },
        {
            id: 'gabarit:safe target?.ownerDocument?.defaultView?.open',
            file: 'p.html',
            text: '<button type="button" (click)="$event.target?.ownerDocument?.defaultView?.open(\'//x.invalid/\')">x</button>\n',
            refused: true,
        },
        {
            id: 'gabarit:keyed chaîne entière',
            file: 'p.html',
            text: "<button type=\"button\" (click)=\"$event['view']['navigation']['navigate']('//x.invalid/')\">x</button>\n",
            refused: true,
        },
        {
            id: "gabarit:keyed calculée $event['vi'+'ew']",
            file: 'p.html',
            text: "<button type=\"button\" (click)=\"$event['vi' + 'ew']['navigation']['navigate']('//x.invalid/')\">x</button>\n",
            refused: true,
        },
        {
            id: "gabarit:safe keyed $event?.['view']",
            file: 'p.html',
            text: "<button type=\"button\" (click)=\"$event?.['view']['navigation']['navigate']('//x.invalid/')\">x</button>\n",
            refused: true,
        },
        {
            id: 'gabarit:$any($event).view',
            file: 'p.html',
            text: '<button type="button" (click)="$any($event).view.navigation.navigate(\'//x.invalid/\')">x</button>\n',
            refused: true,
        },
        {
            id: 'gabarit:non-null target!.ownerDocument',
            file: 'p.html',
            text: '<button type="button" (click)="$event.target!.ownerDocument.defaultView.open(\'//x.invalid/\')">x</button>\n',
            refused: true,
        },
        {
            id: 'gabarit:+ {{ view }}',
            file: 'p.html',
            text: '<p>{{ view }}</p>\n',
            refused: false,
        },
        {
            id: 'gabarit:+ item.parent',
            file: 'p.html',
            text: '@for (item of items(); track item.id) { <p>{{ item.parent }}</p> }\n',
            refused: false,
        },
        {
            id: 'gabarit:+ handle($event)',
            file: 'p.html',
            text: '<button type="button" (click)="handle($event)">x</button>\n',
            refused: false,
        },
        {
            id: 'gabarit:+ edit($event.target.value)',
            file: 'p.html',
            text: '<input (input)="edit(\'email\', $event.target.value)" />\n',
            refused: false,
        },
        {
            id: "gabarit:+ values()['email'] (clé hors $event)",
            file: 'p.html',
            text: "<p>{{ values()['email'] }}</p>\n",
            refused: false,
        },
        {
            id: 'gabarit:+ item?.parent?.name (sûr hors $event)',
            file: 'p.html',
            text: '@for (item of items(); track item.id) { <p>{{ item?.parent?.name }}</p> }\n',
            refused: false,
        },
        {
            id: 'gabarit:+ $event.key',
            file: 'p.html',
            text: '<input (keydown)="onKey($event.key)" />\n',
            refused: false,
        },
        {
            id: 'hôte:N-ts-host-evenement-navigue',
            file: 'x.ts',
            text: "import { Component } from '@angular/core';\n@Component({ selector: 'x', templateUrl: './x.html', host: { '(click)': \"$event.view.navigation.navigate('//x.invalid/')\" } })\nexport class X { handle(v: unknown): void { void v; } }\n",
            refused: true,
        },
        {
            id: "hôte:M-cle-calculee ['host']",
            file: 'x.ts',
            text: "import { Component } from '@angular/core';\n@Component({ selector: 'x', templateUrl: './x.html', ['host']: { '(click)': \"$event.view.navigation.navigate('//x.invalid/')\" } })\nexport class X {}\n",
            refused: true,
        },
        {
            id: 'hôte:clé gabarit [`host`]',
            file: 'x.ts',
            text: "import { Component } from '@angular/core';\n@Component({ selector: 'x', templateUrl: './x.html', [`host`]: { '(click)': \"$event.view.navigation.navigate('//x.invalid/')\" } })\nexport class X {}\n",
            refused: true,
        },
        {
            id: 'hôte:clé gabarit [`(click)`]',
            file: 'x.ts',
            text: "import { Component } from '@angular/core';\n@Component({ selector: 'x', templateUrl: './x.html', host: { [`(click)`]: \"$event.view.navigation.navigate('//x.invalid/')\" } })\nexport class X { handle(v: unknown): void { void v; } }\n",
            refused: true,
        },
        {
            id: 'hôte:clé constante [K]',
            file: 'x.ts',
            text: "const K = '(click)';\nimport { Component } from '@angular/core';\n@Component({ selector: 'x', templateUrl: './x.html', host: { [K]: \"$event.view.navigation.navigate('//x.invalid/')\" } })\nexport class X { handle(v: unknown): void { void v; } }\n",
            refused: true,
        },
        {
            id: 'hôte:valeur concaténée',
            file: 'x.ts',
            text: "import { Component } from '@angular/core';\n@Component({ selector: 'x', templateUrl: './x.html', host: { '(click)': '$event.' + 'view.navigation.navigate(\"//x.invalid/\")' } })\nexport class X { handle(v: unknown): void { void v; } }\n",
            refused: true,
        },
        {
            id: 'hôte:valeur gabarit',
            file: 'x.ts',
            text: "import { Component } from '@angular/core';\n@Component({ selector: 'x', templateUrl: './x.html', host: { '(click)': `$event.view.navigation.navigate('//x.invalid/')` } })\nexport class X { handle(v: unknown): void { void v; } }\n",
            refused: true,
        },
        {
            id: 'hôte:host: HOST (constante)',
            file: 'x.ts',
            text: "const HOST = { '(click)': \"$event.view.navigation.navigate('//x.invalid/')\" };\nimport { Component } from '@angular/core';\n@Component({ selector: 'x', templateUrl: './x.html', host: HOST })\nexport class X {}\n",
            refused: true,
        },
        {
            id: 'hôte:host: { ...H }',
            file: 'x.ts',
            text: "const H = { '(click)': \"$event.view.navigation.navigate('//x.invalid/')\" };\nimport { Component } from '@angular/core';\n@Component({ selector: 'x', templateUrl: './x.html', host: { ...H } })\nexport class X { handle(v: unknown): void { void v; } }\n",
            refused: true,
        },
        {
            id: 'hôte:safe $event?.view',
            file: 'x.ts',
            text: "import { Component } from '@angular/core';\n@Component({ selector: 'x', templateUrl: './x.html', host: { '(click)': \"$event?.view.navigation.navigate('//x.invalid/')\" } })\nexport class X { handle(v: unknown): void { void v; } }\n",
            refused: true,
        },
        {
            id: "hôte:keyed $event['view']",
            file: 'x.ts',
            text: "import { Component } from '@angular/core';\n@Component({ selector: 'x', templateUrl: './x.html', host: { '(click)': \"$event['view'].navigation.navigate('//x.invalid/')\" } })\nexport class X { handle(v: unknown): void { void v; } }\n",
            refused: true,
        },
        {
            id: 'hôte:ownerDocument',
            file: 'x.ts',
            text: "import { Component } from '@angular/core';\n@Component({ selector: 'x', templateUrl: './x.html', host: { '(click)': '$event.target.ownerDocument.defaultView' } })\nexport class X { handle(v: unknown): void { void v; } }\n",
            refused: true,
        },
        {
            id: 'hôte:keyed chaîne calculée entière',
            file: 'x.ts',
            text: "import { Component } from '@angular/core';\n@Component({ selector: 'x', templateUrl: './x.html', host: { '(click)': \"$event['vi'+'ew']['navi'+'gation']['navi'+'gate']('//x.invalid/')\" } })\nexport class X { handle(v: unknown): void { void v; } }\n",
            refused: true,
        },
        {
            id: "hôte:safe keyed $event?.['view']",
            file: 'x.ts',
            text: "import { Component } from '@angular/core';\n@Component({ selector: 'x', templateUrl: './x.html', host: { '(click)': \"$event?.['view']['navigation']['navigate']('//x.invalid/')\" } })\nexport class X { handle(v: unknown): void { void v; } }\n",
            refused: true,
        },
        {
            id: 'hôte:clé gabarit à valeur anodine [`(click)`]: close()',
            file: 'x.ts',
            text: "import { Component } from '@angular/core';\n@Component({ selector: 'x', templateUrl: './x.html', host: { [`(click)`]: 'close()' } })\nexport class X { handle(v: unknown): void { void v; } }\n",
            refused: true,
        },
        {
            id: 'hôte:+ témoin page de référence',
            file: 'x.ts',
            text: "import { Component } from '@angular/core';\n@Component({ selector: 'x', templateUrl: './x.html', host: { '(window:offline)': 'online.set(false)', class: 'page-host' } })\nexport class X { handle(v: unknown): void { void v; } }\n",
            refused: false,
        },
        {
            id: 'hôte:+ handle($event.target.value)',
            file: 'x.ts',
            text: "import { Component } from '@angular/core';\n@Component({ selector: 'x', templateUrl: './x.html', host: { '(input)': 'handle($event.target.value)' } })\nexport class X { handle(v: unknown): void { void v; } }\n",
            refused: false,
        },
        {
            id: 'hôte:+ [attr.aria-label]',
            file: 'x.ts',
            text: "import { Component } from '@angular/core';\n@Component({ selector: 'x', templateUrl: './x.html', host: { '[attr.aria-label]': 'label()', '(keydown.escape)': 'close()' } })\nexport class X { handle(v: unknown): void { void v; } }\n",
            refused: false,
        },
        {
            id: 'hôte:+ clé calculée HORS décorateur (edit)',
            file: 'x.ts',
            text: 'export class Y { values: Record<string, string> = {}; edit(control: string, value: string): void { this.values = { ...this.values, [control]: value }; } }\n',
            refused: false,
        },
        {
            id: 'hôte:+ sans host',
            file: 'x.ts',
            text: "import { Component } from '@angular/core';\n@Component({ selector: 'x', templateUrl: './x.html' })\nexport class X {}\n",
            refused: false,
        },
    ].map((probe) => Object.freeze(probe))
);
