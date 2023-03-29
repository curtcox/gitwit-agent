const fs = require('fs');
const tar = require('tar');
const path = require('path');
const readline = require('readline');
const { Configuration, OpenAIApi } = require('openai')
const Docker = require('dockerode');

const template = require('./prompt.js')
require('dotenv').config();

const baseImage = "node:latest";
const gptModel = "gpt-3.5-turbo";
const buildDirectory = "./build/";
const containerHome = "/app/";

const buildScriptPath = buildDirectory + "build.sh";
const environmentFilePath = buildDirectory + "build.env";
const projectFilePath = buildDirectory + "build.json";

// User input:

function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }))
}

// Reading and writing files:

function createBuildDirectory() {
    if (!fs.existsSync(buildDirectory)) {
        fs.mkdirSync(buildDirectory);
    }
}

async function writeFile(path, contents) {
    await fs.promises.writeFile(path, contents);
    console.log(`Wrote ${path}.`);
}

async function readProjectFile() {
    const data = await fs.promises.readFile(buildDirectory + "build.json");
    return JSON.parse(data)
}

// OpenAI API:

async function simpleOpenAIRequest(prompt) {

    const configuration = new Configuration({
        apiKey: process.env.OPENAI_API_KEY,
    })
    const openai = new OpenAIApi(configuration)

    let completion = await openai.createChatCompletion({
        model: gptModel,
        messages: [
            {
                role: 'user',
                content: prompt,
            },
        ],
    })
    return completion.data.choices[0].message.content;
}

// Docker:

async function createContainer(docker, tag, environment) {
    // create a new container from the image
    return await docker.createContainer({
        Image: tag, // specify the image to use
        Env: environment,
        Tty: true,
        Cmd: ['/bin/sh'],
        OpenStdin: true,
    });
}

async function startContainer(container) {
    process.on('SIGINT', async function () {
        console.log("Caught interrupt signal");
        await container.stop({ force: true });
    });
    await container.start();
    const stream = await container.logs({
        follow: true,
        stdout: true,
        stderr: true
    });
    stream.on('data', chunk => console.log(chunk.toString()));
    return stream;
}

async function waitForStreamEnd(stream) {
    return new Promise(async (resolve, reject) => {
        try {
            stream.on('end', async () => {
                resolve();
            });
        } catch (err) {
            reject(err);
        }
    });
}

async function runCommandInContainer(container, command) {
    const exec = await container.exec({
        Cmd: command,
        AttachStdout: true,
        AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: true });
    stream.on('data', (data) => {
        console.log(`Command output: ${data}`);
    });
    await waitForStreamEnd(stream);
}

async function copyFileToContainer(container, localFilePath, containerFilePath) {
    const baseDir = path.dirname(localFilePath);
    const archive = tar.create({ gzip: false, portable: true, cwd: baseDir }, [path.basename(localFilePath)]);
    await container.putArchive(archive, { path: containerFilePath });
}
// Post-processing:

function applyCorrections(buildScript) {
    // What a hack! But small corrections like this will necessary for a while.
    return buildScript.replaceAll(/^npx /mg, 'npx --yes ')
        .replaceAll(/^echo /mg, 'echo -e ')
        .replaceAll(/^git push .*$/mg, '')
        .replaceAll(/^git remote .*$/mg, '')
        .replaceAll(/^git commit -m "(.*)$/mg, 'git commit -m "👷🏼 $1')
        .replaceAll(/^git commit (.*)$/mg, 'git commit -a $1');
}

// Main script:

(async function () {

    let offline = process.argv.includes('--offline');
    let again = process.argv.includes('--again');
    let dryRun = process.argv.includes('--debug');

    let description;
    let name;

    createBuildDirectory();

    if (offline || again) {
        ({ description, name } = await readProjectFile());
    }

    if (!description || !name) {
        console.log("Let's cook up a new project!")
        description = await askQuestion("What would you like to make? ");
        name = await askQuestion("Repository name: ");
    }

    const environment = [
        `REPO_NAME=${name}`,
        `REPO_DESCRIPTION=${description}`,
        `GIT_AUTHOR_EMAIL=${process.env.GIT_AUTHOR_EMAIL}`,
        `GIT_AUTHOR_NAME=${process.env.GIT_AUTHOR_NAME}`,
        `GITHUB_USERNAME=${process.env.GITHUB_USERNAME}`,
        `GITHUB_TOKEN=${process.env.GITHUB_TOKEN}`,
        `GITWIT_VERSION=${process.env.npm_package_version}`
    ];
    await writeFile(environmentFilePath, environment.join("\n"));

    const projectInfo = {
        name: name,
        description: description,
        generatorVersion: process.env.npm_package_version,
        gptModel: gptModel
    };
    await writeFile(projectFilePath, JSON.stringify(projectInfo))

    if (!offline) {
        const prompt = template
            .replace("{DESCRIPTION}", description)
            .replace("{REPOSITORY_NAME}", name)
            .replace("{BASE_IMAGE}", baseImage);

        console.log("Calling on the great machine god...")
        let buildScript = await simpleOpenAIRequest(prompt)
        console.log("Prayers were answered.")

        buildScript = applyCorrections(buildScript.trim());
        await writeFile(buildScriptPath, buildScript)
    }

    const docker = new Docker();

    const container = await createContainer(docker, baseImage, environment);
    console.log(`Container ${container.id} created.`);

    if (dryRun) {

        // This is how we can debug the build script interactively.
        console.log("Dry run, not starting container. To debug, run:");
        console.log("-----")
        console.log(`docker run --rm -it --env-file ${buildDirectory}build.env --entrypoint bash ${dockerTag}`)
        console.log(`source /app/create_github_repo.sh`)
        console.log("-----")

    } else {

        await startContainer(container);
        console.log(`Container ${container.id} started.`);

        // Run the build scripts in the container.
        await runCommandInContainer(container, ["mkdir", containerHome])
        await copyFileToContainer(container, buildScriptPath, containerHome)
        await copyFileToContainer(container, "./create_github_repo.sh", containerHome)
        await runCommandInContainer(container, ["bash", containerHome + "create_github_repo.sh"])

        await container.stop();
        console.log(`Container ${container.id} stopped.`);

        await container.remove()
        console.log(`Container ${container.id} removed.`);
    }

})();