import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Resolve the host from its working directory, independently of the plugin's folder name.
export const hostRoot = process.cwd();
const packagePath = path.join(hostRoot, 'package.json');
const hostPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
if (hostPackage.name !== 'sillytavern') throw new Error('Start this plugin through SillyTavern from its application directory.');
export const packageVersion = hostPackage.version;
const requireHost = createRequire(pathToFileURL(packagePath));
const hostModule = relative => import(pathToFileURL(path.join(hostRoot, relative)).href);
export const fetch = (await import(pathToFileURL(requireHost.resolve('node-fetch')).href)).default;
export const express = requireHost('express');
export const { readSecret, SECRET_KEYS } = await hostModule('src/endpoints/secrets.js');
export const { generateJWTToken, getProjectIdFromServiceAccount } = await hostModule('src/endpoints/google.js');
export const { getConfigValue, tryParse } = await hostModule('src/util.js');
export const { getPromptNames, calculateGoogleBudgetTokens } = await hostModule('src/prompt-converters.js');
export const { GEMINI_SAFETY, VERTEX_SAFETY } = await hostModule('src/constants.js');
