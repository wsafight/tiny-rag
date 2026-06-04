import { defineConfig } from '@rslib/core';

const shared = {
  output: {
    target: 'node',
    minify: false,
    distPath: {
      root: 'dist',
    },
  },
  syntax: 'es2022',
} as const;

export default defineConfig({
  lib: [
    {
      id: 'esm',
      format: 'esm',
      dts: true,
      source: {
        tsconfigPath: './tsconfig.build.json',
        entry: {
          index: './src/index.ts',
        },
      },
      ...shared,
    },
    {
      id: 'cjs',
      format: 'cjs',
      source: {
        tsconfigPath: './tsconfig.build.json',
        entry: {
          index: './src/index.ts',
        },
      },
      ...shared,
    },
  ],
});
