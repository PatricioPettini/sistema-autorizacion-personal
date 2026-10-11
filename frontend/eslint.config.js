// Un solo chequeo, y es el que importa: las reglas de hooks de React.
//
// Existe por un error concreto que se cometió DOS veces: poner un `useState` o un `useEffect`
// después del `if (!data) return <Spinner />`. React cuenta los hooks por orden, así que en el
// primer render (sin datos) cuenta menos que en el siguiente y la pantalla queda EN BLANCO —no
// tira un error visible, no lo agarra TypeScript y no lo agarran los tests del backend—.
//
// No se agregan reglas de estilo a propósito: un lint que grita por cosas que no rompen nada
// termina ignorado, y entonces tampoco avisa de las que sí.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // Lo demás lo cubre `tsc --noEmit`, que ya corre en el build.
      ...Object.fromEntries(Object.keys(js.configs.recommended.rules).map((r) => [r, 'off'])),
    },
  },
);
