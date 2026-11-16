/**
 * 🎨 A COR DO PROJETO: as paletas padrão do Tailwind (os valores do `theme.css` dele) que o projeto pode usar no lugar do
 * verde do tema. ⚖️ Todo destaque da tela é `emerald-*`, e no Tailwind 4 cada classe lê a variável `--color-emerald-*`:
 * trocar as variáveis troca a cor em toda a tela, sem tocar nos componentes. Vermelho e amarelo ficam de fora (são erro e
 * alerta). Mesma lista no servidor (`PROJECT_COLORS`).
 */
export const PROJECT_COLORS = ['emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'orange', 'lime'] as const
export type TProjectColor = (typeof PROJECT_COLORS)[number]

export const SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'] as const

/** Os valores de cada paleta (oklch), do tema padrão do Tailwind 4. */
export const PALETTES: Record<TProjectColor, Record<(typeof SHADES)[number], string>> = {
  emerald: {
    '50': 'oklch(97.9% 0.021 166.113)',
    '100': 'oklch(95% 0.052 163.051)',
    '200': 'oklch(90.5% 0.093 164.15)',
    '300': 'oklch(84.5% 0.143 164.978)',
    '400': 'oklch(76.5% 0.177 163.223)',
    '500': 'oklch(69.6% 0.17 162.48)',
    '600': 'oklch(59.6% 0.145 163.225)',
    '700': 'oklch(50.8% 0.118 165.612)',
    '800': 'oklch(43.2% 0.095 166.913)',
    '900': 'oklch(37.8% 0.077 168.94)',
    '950': 'oklch(26.2% 0.051 172.552)',
  },
  teal: {
    '50': 'oklch(98.4% 0.014 180.72)',
    '100': 'oklch(95.3% 0.051 180.801)',
    '200': 'oklch(91% 0.096 180.426)',
    '300': 'oklch(85.5% 0.138 181.071)',
    '400': 'oklch(77.7% 0.152 181.912)',
    '500': 'oklch(70.4% 0.14 182.503)',
    '600': 'oklch(60% 0.118 184.704)',
    '700': 'oklch(51.1% 0.096 186.391)',
    '800': 'oklch(43.7% 0.078 188.216)',
    '900': 'oklch(38.6% 0.063 188.416)',
    '950': 'oklch(27.7% 0.046 192.524)',
  },
  cyan: {
    '50': 'oklch(98.4% 0.019 200.873)',
    '100': 'oklch(95.6% 0.045 203.388)',
    '200': 'oklch(91.7% 0.08 205.041)',
    '300': 'oklch(86.5% 0.127 207.078)',
    '400': 'oklch(78.9% 0.154 211.53)',
    '500': 'oklch(71.5% 0.143 215.221)',
    '600': 'oklch(60.9% 0.126 221.723)',
    '700': 'oklch(52% 0.105 223.128)',
    '800': 'oklch(45% 0.085 224.283)',
    '900': 'oklch(39.8% 0.07 227.392)',
    '950': 'oklch(30.2% 0.056 229.695)',
  },
  sky: {
    '50': 'oklch(97.7% 0.013 236.62)',
    '100': 'oklch(95.1% 0.026 236.824)',
    '200': 'oklch(90.1% 0.058 230.902)',
    '300': 'oklch(82.8% 0.111 230.318)',
    '400': 'oklch(74.6% 0.16 232.661)',
    '500': 'oklch(68.5% 0.169 237.323)',
    '600': 'oklch(58.8% 0.158 241.966)',
    '700': 'oklch(50% 0.134 242.749)',
    '800': 'oklch(44.3% 0.11 240.79)',
    '900': 'oklch(39.1% 0.09 240.876)',
    '950': 'oklch(29.3% 0.066 243.157)',
  },
  blue: {
    '50': 'oklch(97% 0.014 254.604)',
    '100': 'oklch(93.2% 0.032 255.585)',
    '200': 'oklch(88.2% 0.059 254.128)',
    '300': 'oklch(80.9% 0.105 251.813)',
    '400': 'oklch(70.7% 0.165 254.624)',
    '500': 'oklch(62.3% 0.214 259.815)',
    '600': 'oklch(54.6% 0.245 262.881)',
    '700': 'oklch(48.8% 0.243 264.376)',
    '800': 'oklch(42.4% 0.199 265.638)',
    '900': 'oklch(37.9% 0.146 265.522)',
    '950': 'oklch(28.2% 0.091 267.935)',
  },
  indigo: {
    '50': 'oklch(96.2% 0.018 272.314)',
    '100': 'oklch(93% 0.034 272.788)',
    '200': 'oklch(87% 0.065 274.039)',
    '300': 'oklch(78.5% 0.115 274.713)',
    '400': 'oklch(67.3% 0.182 276.935)',
    '500': 'oklch(58.5% 0.233 277.117)',
    '600': 'oklch(51.1% 0.262 276.966)',
    '700': 'oklch(45.7% 0.24 277.023)',
    '800': 'oklch(39.8% 0.195 277.366)',
    '900': 'oklch(35.9% 0.144 278.697)',
    '950': 'oklch(25.7% 0.09 281.288)',
  },
  violet: {
    '50': 'oklch(96.9% 0.016 293.756)',
    '100': 'oklch(94.3% 0.029 294.588)',
    '200': 'oklch(89.4% 0.057 293.283)',
    '300': 'oklch(81.1% 0.111 293.571)',
    '400': 'oklch(70.2% 0.183 293.541)',
    '500': 'oklch(60.6% 0.25 292.717)',
    '600': 'oklch(54.1% 0.281 293.009)',
    '700': 'oklch(49.1% 0.27 292.581)',
    '800': 'oklch(43.2% 0.232 292.759)',
    '900': 'oklch(38% 0.189 293.745)',
    '950': 'oklch(28.3% 0.141 291.089)',
  },
  purple: {
    '50': 'oklch(97.7% 0.014 308.299)',
    '100': 'oklch(94.6% 0.033 307.174)',
    '200': 'oklch(90.2% 0.063 306.703)',
    '300': 'oklch(82.7% 0.119 306.383)',
    '400': 'oklch(71.4% 0.203 305.504)',
    '500': 'oklch(62.7% 0.265 303.9)',
    '600': 'oklch(55.8% 0.288 302.321)',
    '700': 'oklch(49.6% 0.265 301.924)',
    '800': 'oklch(43.8% 0.218 303.724)',
    '900': 'oklch(38.1% 0.176 304.987)',
    '950': 'oklch(29.1% 0.149 302.717)',
  },
  fuchsia: {
    '50': 'oklch(97.7% 0.017 320.058)',
    '100': 'oklch(95.2% 0.037 318.852)',
    '200': 'oklch(90.3% 0.076 319.62)',
    '300': 'oklch(83.3% 0.145 321.434)',
    '400': 'oklch(74% 0.238 322.16)',
    '500': 'oklch(66.7% 0.295 322.15)',
    '600': 'oklch(59.1% 0.293 322.896)',
    '700': 'oklch(51.8% 0.253 323.949)',
    '800': 'oklch(45.2% 0.211 324.591)',
    '900': 'oklch(40.1% 0.17 325.612)',
    '950': 'oklch(29.3% 0.136 325.661)',
  },
  pink: {
    '50': 'oklch(97.1% 0.014 343.198)',
    '100': 'oklch(94.8% 0.028 342.258)',
    '200': 'oklch(89.9% 0.061 343.231)',
    '300': 'oklch(82.3% 0.12 346.018)',
    '400': 'oklch(71.8% 0.202 349.761)',
    '500': 'oklch(65.6% 0.241 354.308)',
    '600': 'oklch(59.2% 0.249 0.584)',
    '700': 'oklch(52.5% 0.223 3.958)',
    '800': 'oklch(45.9% 0.187 3.815)',
    '900': 'oklch(40.8% 0.153 2.432)',
    '950': 'oklch(28.4% 0.109 3.907)',
  },
  orange: {
    '50': 'oklch(98% 0.016 73.684)',
    '100': 'oklch(95.4% 0.038 75.164)',
    '200': 'oklch(90.1% 0.076 70.697)',
    '300': 'oklch(83.7% 0.128 66.29)',
    '400': 'oklch(75% 0.183 55.934)',
    '500': 'oklch(70.5% 0.213 47.604)',
    '600': 'oklch(64.6% 0.222 41.116)',
    '700': 'oklch(55.3% 0.195 38.402)',
    '800': 'oklch(47% 0.157 37.304)',
    '900': 'oklch(40.8% 0.123 38.172)',
    '950': 'oklch(26.6% 0.079 36.259)',
  },
  lime: {
    '50': 'oklch(98.6% 0.031 120.757)',
    '100': 'oklch(96.7% 0.067 122.328)',
    '200': 'oklch(93.8% 0.127 124.321)',
    '300': 'oklch(89.7% 0.196 126.665)',
    '400': 'oklch(84.1% 0.238 128.85)',
    '500': 'oklch(76.8% 0.233 130.85)',
    '600': 'oklch(64.8% 0.2 131.684)',
    '700': 'oklch(53.2% 0.157 131.589)',
    '800': 'oklch(45.3% 0.124 130.933)',
    '900': 'oklch(40.5% 0.101 131.063)',
    '950': 'oklch(27.4% 0.072 132.109)',
  },
}

/** O nome da paleta na tela. */
export const PROJECT_COLOR_LABEL: Record<TProjectColor, string> = {
  emerald: 'Esmeralda (padrão)',
  teal: 'Verde-azulado',
  cyan: 'Ciano',
  sky: 'Céu',
  blue: 'Azul',
  indigo: 'Índigo',
  violet: 'Violeta',
  purple: 'Roxo',
  fuchsia: 'Fúcsia',
  pink: 'Rosa',
  orange: 'Laranja',
  lime: 'Lima',
}

/**
 * Pinta o destaque da tela com a cor do projeto: as variáveis `--color-emerald-*` passam a valer a paleta escolhida.
 * Sem cor (ou esmeralda), volta ao tema.
 */
export function applyAccent(color: string | undefined, root: HTMLElement = document.documentElement): void {
  const palette = color && color !== 'emerald' && color in PALETTES ? PALETTES[color as TProjectColor] : undefined
  for (const shade of SHADES) {
    if (palette) root.style.setProperty(`--color-emerald-${shade}`, palette[shade])
    else root.style.removeProperty(`--color-emerald-${shade}`)
  }
}
