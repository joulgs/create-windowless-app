import { default as commander } from "commander";
import chalk from "chalk";
import * as envinfo from "envinfo";
import * as path from "path";
import * as fs from "fs-extra";
import type { InvalidNames, LegacyNames, ValidNames } from "validate-npm-package-name";
import validateProjectName from "validate-npm-package-name";
import spawn from "cross-spawn";
import semver from "semver";
import inquirer from "inquirer";
import { compileLauncher } from "./launcherCompiler";
import consts from "./consts";
import { checkAppName, getNexeCommand, isSafeToCreateProjectIn, mergeIntoPackageJson, PACKAGE_JSON_FILENAME, replaceAppNamePlaceholder } from "./createWindowlessAppUtils";
import { copyFile, readJsonResource, readResource, writeFile, writeJson } from "./fileUtils";
import { checkNodeVersion, checkThatNpmCanReadCwd } from "./nodeUtils";
import type { Command } from "commander";

const packageJson = require(`../${PACKAGE_JSON_FILENAME}`);

const tsConfigFilename = "tsconfig.json";
const WebpackConfigFilename = "webpack.config.js";

// TypeScript
const tsWebpackConfigResourceLocation = `../templates/typescript/${WebpackConfigFilename}`;
const tsConfigResourceLocation = `../templates/typescript/${tsConfigFilename}`;
const tsIndexResourceLocation = "../templates/typescript/src/index.ts";
const tsLauncherCompilerLocation = "../templates/typescript/launcher/launcherCompiler.ts";

// JavaScript
const jsWebpackConfigResourceLocation = `../templates/javascript/${WebpackConfigFilename}`;
const jsIndexResourceLocation = "../templates/javascript/src/index.js";
const jsLauncherCompilerLocation = "../templates/javascript/launcher/launcherCompiler.js";

// Launcher Source
const launcherSrcResourceLocation = "../templates/common/src/launcher.cs";
const launcherSrcModifiedLocation = "launcher/launcher.cs";

// Default icon location
const defaultLauncherIconLocation = "../templates/common/resources/windows-launcher.ico";

type ProgramConfig = {
    projectName: string;
    icon?: string;
    typescript: boolean;
    husky: boolean;
    skipInstall: boolean;
    nodeVersion: string;
    verbose: boolean;
};

function interactiveMode(): Promise<ProgramConfig> {
    return inquirer.prompt([
        {
            type: "input",
            message: "Project Name:",
            name: "projectName",
            validate: (value) => {
                const result: ValidNames | InvalidNames | LegacyNames = validateProjectName(value);
                return result.validForNewPackages || ((result as InvalidNames)?.errors?.[0]) || ((result as LegacyNames)?.warnings?.[0]) || "Invalid project name";
            }
        },
        {
            type: "input",
            message: "Icon:",
            name: "icon"
        },
        {
            type: "confirm",
            message: "TypeScript:",
            name: "typescript",
            default: true
        },
        {
            type: "confirm",
            message: "Install Husky:",
            name: "husky",
            default: true
        },
        {
            type: "confirm",
            message: "Skip NPM Install:",
            name: "skipInstall",
            default: false
        },
        {
            type: "input",
            message: "Node Version:",
            name: "nodeVersion",
            validate: (value) => !value || !!semver.valid(value) || "Invalid node version"
        },
        {
            type: "confirm",
            message: "Verbose:",
            name: "verbose",
            default: false
        }
    ]);
}

const validateInput = (programConfig: ProgramConfig, program: Command): void => {
    if (!programConfig.projectName || typeof programConfig.projectName === "undefined") {
        console.error(`${chalk.red("Missing project name")}`);
        console.log();
        program.outputHelp();
        process.exit(1);
    }

    if (programConfig.icon && !fs.pathExistsSync(programConfig.icon)) {
        console.log(`Cannot find icon in ${chalk.red(programConfig.icon)}. Switching to ${chalk.green("default")} icon.`);
        programConfig.icon = undefined;
    }
};


const install = async (root: string, dependencies: string[], isDev: boolean, programConfig: ProgramConfig): Promise<void> => {
    const { verbose, skipInstall } = programConfig;

    if (!skipInstall) {
        const command = "npm";
        const args = ["install", isDev ? "--save-dev" : "--save", "--save-exact", "--loglevel", "error"].concat(dependencies);
        if (verbose) {
            args.push("--verbose");
        }
        console.log(`Installing ${chalk.green(isDev ? "dev dependencies" : "dependencies")}.`);
        console.log();

        spawn.sync(command, args, { stdio: "inherit" });
    }
    else {
        console.log(`Adding ${chalk.green(isDev ? "dev dependencies" : "dependencies")} to package.json (skipping installation)`);
        console.log();

        const dependenciesObject = dependencies.reduce((acc, cur) => {
            acc[cur] = "^x.x.x";
            return acc;
        }, {});
        mergeIntoPackageJson(root, isDev ? "devDependencies" : "dependencies", dependenciesObject);
    }
};

const buildTypeScriptProject = (root: string, appName: string, nodeVersion: string, husky: boolean): void => {
    console.log(`Building project ${chalk.green("files")}.`);
    console.log();

    writeJson(path.resolve(root, tsConfigFilename), readJsonResource(tsConfigResourceLocation));
    writeFile(path.resolve(root, WebpackConfigFilename), replaceAppNamePlaceholder(readResource(tsWebpackConfigResourceLocation), appName));
    fs.ensureDirSync(path.resolve(root, "src"));
    writeFile(path.resolve(root, "src", "index.ts"), replaceAppNamePlaceholder(readResource(tsIndexResourceLocation), appName));

    // Add scripts
    const scripts: { [key: string]: string } = {
        "start": "ts-node src/index.ts",
        "tsc": "tsc",
        "webpack": "webpack",
        "nexe": getNexeCommand(appName, nodeVersion),
        "build": "npm run tsc && npm run webpack && npm run nexe",
        "check-csc": "ts-node -e \"require(\"\"./launcher/launcherCompiler\"\").checkCscInPath(true)\"",
        "rebuild-launcher": `csc /t:winexe /out:resources/bin/${appName}-launcher.exe /win32icon:launcher/launcher.ico launcher/launcher.cs`
    };
    mergeIntoPackageJson(root, "scripts", scripts);

    // Add husky
    if (husky) {
        const husky = {
            hooks: {
                "pre-commit": `git diff HEAD --exit-code --stat launcher.cs || npm run check-csc && npm run rebuild-launcher && git add resources/bin/${appName}-launcher.exe`
            }
        };
        mergeIntoPackageJson(root, "husky", husky);
    }
};

const buildJavaScriptProject = (root: string, appName: string, nodeVersion: string, husky: boolean): void => {
    console.log(`Building project ${chalk.green("files")}.`);
    console.log();

    writeFile(path.resolve(root, WebpackConfigFilename), replaceAppNamePlaceholder(readResource(jsWebpackConfigResourceLocation), appName));
    fs.ensureDirSync(path.resolve(root, "src"));
    writeFile(path.resolve(root, "src", "index.js"), replaceAppNamePlaceholder(readResource(jsIndexResourceLocation), appName));

    // Add scripts
    const scripts: { [key: string]: string } = {
        "start": "node src/index.js",
        "webpack": "webpack",
        "nexe": getNexeCommand(appName, nodeVersion),
        "build": "npm run webpack && npm run nexe",
        "check-csc": "node -e \"require(\"\"./launcher/launcherCompiler\"\").checkCscInPath(true)\"",
        "rebuild-launcher": `csc /t:winexe /out:resources/bin/${appName}-launcher.exe /win32icon:launcher/launcher.ico launcher/launcher.cs`
    };
    mergeIntoPackageJson(root, "scripts", scripts);

    // Add husky
    if (husky) {
        const husky = {
            hooks: {
                "pre-commit": `git diff HEAD --exit-code --stat launcher.cs || npm run check-csc && npm run rebuild-launcher && git add resources/bin/${appName}-launcher.exe`
            }
        };
        mergeIntoPackageJson(root, "husky", husky);
    }
};

export const buildLauncher = (root: string, appName: string, icon: string, typescript: boolean): Promise<void> => {
    console.log(`Building project ${chalk.green("launcher")}.`);
    console.log();

    fs.ensureDirSync(path.resolve("launcher"));
    writeFile(path.resolve(launcherSrcModifiedLocation), replaceAppNamePlaceholder(readResource(launcherSrcResourceLocation), appName));
    if (typescript) {
        copyFile(path.resolve(__dirname, tsLauncherCompilerLocation), path.resolve(root, "launcher", "launcherCompiler.ts"));
    }
    else {
        copyFile(path.resolve(__dirname, jsLauncherCompilerLocation), path.resolve(root, "launcher", "launcherCompiler.js"));
    }

    // Resolve icon
    let iconLocation: string;
    if (icon) {
        iconLocation = path.resolve(icon);
        console.log(`Building launcher with icon: ${chalk.green(icon)}.`);
    }
    else {
        iconLocation = path.resolve(__dirname, defaultLauncherIconLocation);
        console.log(`Building launcher with ${chalk.green("default")} icon.`);
    }
    copyFile(iconLocation, path.resolve(root, "launcher", "launcher.ico"));

    // Compiled file location
    const outputLocation: string = path.resolve(root, "resources", "bin", `${appName}-launcher.exe`);

    return compileLauncher(launcherSrcModifiedLocation, outputLocation, iconLocation);
};

const run = async (root: string, appName: string, originalDirectory: string, programConfig: ProgramConfig): Promise<void> => {
    const { typescript, husky, icon, nodeVersion } = programConfig;
    const dependencies = [...consts.dependencies];
    const devDependencies = [...consts.devDependencies];
    if (typescript) {
        devDependencies.push(...consts.tsDevDependencies);
    }
    if (husky) {
        devDependencies.push(...consts.huskyDependencies);
    }

    try {
        await install(root, dependencies, false, programConfig);
        await install(root, devDependencies, true, programConfig);
        const checkedNodeVersion: string = await checkNodeVersion(nodeVersion);
        if (typescript) {
            buildTypeScriptProject(root, appName, checkedNodeVersion, husky);
        }
        else {
            buildJavaScriptProject(root, appName, checkedNodeVersion, husky);
        }

        // Launcher
        fs.ensureDirSync(path.resolve(root, "resources", "bin"));
        await buildLauncher(root, appName, icon, typescript);

        console.log("Done");
    }
    catch (reason) {
        console.log();
        console.log("Aborting installation.");
        if (reason.command) {
            console.log(`  ${chalk.cyan(reason.command)} has failed.`);
        }
        else {
            console.log(chalk.red("Unexpected error. Please report it as a bug:"));
            console.log(reason);
        }
        console.log();

        // On 'exit' we will delete these files from target directory.
        const knownGeneratedFiles = [...consts.knownGeneratedFiles];
        const currentFiles = fs.readdirSync(path.join(root));
        currentFiles.forEach((file) => {
            knownGeneratedFiles.forEach((fileToMatch) => {
                // This removes all knownGeneratedFiles.
                if (file === fileToMatch) {
                    console.log(`Deleting generated file... ${chalk.cyan(file)}`);
                    fs.removeSync(path.join(root, file));
                }
            });
        });
        const remainingFiles = fs.readdirSync(path.join(root));
        if (!remainingFiles.length) {
            // Delete target folder if empty
            console.log(`Deleting ${chalk.cyan(`${appName}/`)} from ${chalk.cyan(path.resolve(root, ".."))}`);
            process.chdir(path.resolve(root, ".."));
            fs.removeSync(path.join(root));
        }
        console.log("Done (with errors).");
        process.exit(1);
    }
};

const createApp = (programConfig: ProgramConfig): Promise<void> => {
    const { projectName } = programConfig;
    const root: string = path.resolve(projectName);
    const appName: string = path.basename(root);

    checkAppName(appName);
    fs.ensureDirSync(projectName);
    if (!isSafeToCreateProjectIn(root, projectName)) {
        process.exit(1);
    }

    console.log(`Creating a new windowless app in ${chalk.green(root)}.`);
    console.log();

    const packageJson = {
        name: appName,
        version: "0.1.0",
        private: true,
        main: "_build/index.js"
    };
    writeJson(path.join(root, "package.json"), packageJson);

    const originalDirectory = process.cwd();
    process.chdir(root);
    if (!checkThatNpmCanReadCwd()) {
        process.exit(1);
    }

    return run(root, appName, originalDirectory, programConfig);
};

export const createWindowlessApp = async (argv: string[]): Promise<void> => {
    let projectName: string = undefined;

    const program: Command = new commander.Command(packageJson.name)
        .version(packageJson.version)
        .arguments("<project-directory>")
        .usage(`${chalk.green("<project-directory>")} [options]`)
        .action((name) => {
            projectName = name;
        })
        .option("--verbose", "print additional logs")
        .option("--info", "print environment debug info")
        .option("--interactive", "interactive mode")
        .option("--no-typescript", "use javascript rather than typescript")
        .option("--no-husky", "do not install husky pre-commit hook for building launcher")
        .option("--skip-install", "write dependencies to package.json without installing")
        .option("--icon <icon>", "override default launcher icon file")
        .option("--node-version <nodeVersion>", "override node version to bundle")
        .allowUnknownOption()
        .on("--help", () => {
            console.log(`    Only ${chalk.green("<project-directory>")} is required.`);
            console.log();
            console.log("    If you have any problems, do not hesitate to file an issue:");
            console.log(`      ${chalk.cyan("https://github.com/yoavain/create-windowless-app/issues/new")}`);
            console.log();
        })
        .parse(argv);

    if (program.info) {
        console.log(chalk.bold("\nEnvironment Info:"));
        return envinfo
            .run(
                {
                    System: ["OS", "CPU"],
                    Binaries: ["Node", "npm"],
                    npmPackages: [...consts.dependencies, ...consts.devDependencies, ...consts.tsDevDependencies],
                    npmGlobalPackages: ["create-windowless-app"]
                },
                {
                    duplicates: true,
                    showNotFound: true
                }
            )
            .then(console.log);
    }

    let programConfig: ProgramConfig;
    if (program.interactive) {
        programConfig = await interactiveMode();
    }
    else {
        programConfig = {
            projectName,
            verbose: program.verbose,
            typescript: program.typescript,
            husky: program.husky,
            skipInstall: program.skipInstall,
            icon: program.icon,
            nodeVersion: program.nodeVersion
        };
    }

    validateInput(programConfig, program);

    if (programConfig.projectName) {
        return createApp(programConfig);
    }
};
