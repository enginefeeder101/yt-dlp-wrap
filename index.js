const EventEmitter = require("events").EventEmitter
const execFile = require("child_process").execFile;
const fs = require("fs");
const https = require("https");
const os = require("os");
const Readable = require("stream").Readable;
const spawn = require("child_process").spawn;

class YoutubeDlWrap
{
    constructor(binaryPath)
    {
        this.progressRegex = /\[download\] *(.*) of (.*) at (.*) ETA (.*)/;
        this.setBinaryPath(binaryPath ? binaryPath : "youtube-dl");
    }

    getBinaryPath()
    {
        return this.binaryPath;
    }
    setBinaryPath(binaryPath)
    {
        this.binaryPath = binaryPath;
    }

    static getGithubReleases(page = 1, perPage = 1)
    {
        return new Promise( (resolve, reject) =>
        {
            const apiURL = "https://api.github.com/repos/ytdl-org/youtube-dl/releases?page=" + page + "&per_page=" + perPage;
            https.get(apiURL, { headers: { "User-Agent": "node" } }, (response) =>
            {
                let responseString = "";
                response.setEncoding("utf8");
                response.on("data", (body) => responseString += body);
                response.on("error", (e) => reject(e));
                response.on("end", () => response.statusCode == 200 ? resolve(JSON.parse(responseString)) : reject(response));
            });
        });
    }

    static async downloadYoutubeDl(filePath, version, platform = os.platform())
    {
        let fileName = platform == "win32" ? "youtube-dl.exe" : "youtube-dl";
        if(!version)
            version = (await YoutubeDlWrap.getGithubReleases(1, 1))[0].tag_name;
        if(!filePath)
            filePath = "./" + fileName;

        return new Promise( (resolve, reject) =>
        {
            let binaryURL = "https://github.com/ytdl-org/youtube-dl/releases/download/" + version + "/" + fileName;
            https.get(binaryURL, (redirectResponse) =>
            {
                redirectResponse.on("error", (e) => reject(e));
                https.get(redirectResponse.headers.location, (binaryResponse) =>
                {
                    binaryResponse.pipe(fs.createWriteStream(filePath));
                    binaryResponse.on("error", (e) => reject(e));
                    binaryResponse.on("end", () => binaryResponse.statusCode == 200 ? resolve(binaryResponse) : reject(binaryResponse));
                });
            });
        });
    }

    async getExtractors()
    {
        let youtubeDlStdout = await this.execPromise(["--list-extractors"]);
        return youtubeDlStdout.split("\n");         
    }
    async getExtractorDescriptions()
    {
        let youtubeDlStdout = await this.execPromise(["--extractor-descriptions"]);
        return youtubeDlStdout.split("\n");         
    }

    async getHelp()
    {
        let youtubeDlStdout = await this.execPromise(["--help"]);
        return youtubeDlStdout;         
    }
    async getUserAgent()
    {
        let youtubeDlStdout = await this.execPromise(["--dump-user-agent"]);
        return youtubeDlStdout;         
    }
    async getVersion()
    {
        let youtubeDlStdout = await this.execPromise(["--version"]);
        return youtubeDlStdout;         
    }

    async getVideoInfo(youtubeDlArguments)
    {
        if(typeof youtubeDlArguments == "string")
            youtubeDlArguments = [youtubeDlArguments];
        if(!youtubeDlArguments.includes("-f") && !youtubeDlArguments.includes("--format"))
            youtubeDlArguments = youtubeDlArguments.concat(["-f", "best"]);

        let youtubeDlStdout = await this.execPromise(youtubeDlArguments.concat(["--dump-json"]));
        try{
            return JSON.parse(youtubeDlStdout); 
        }
        catch(e){
            return JSON.parse("[" + youtubeDlStdout.replace(/\n/g, ",").slice(0, -1)  + "]"); 
        }
    }

    setDefaultOptions(options)
    {
	    if(!options.maxBuffer)
            options.maxBuffer = 1024 * 1024 * 1024;
        return options;
    }

    exec(youtubeDlArguments = [], options = {})
    {
        options = this.setDefaultOptions(options);
        const execEventEmitter = new EventEmitter();
        const youtubeDlProcess = spawn(this.binaryPath, youtubeDlArguments, options);

        youtubeDlProcess.stdout.on("data", (data) =>
        {
            let stringData = data.toString();
            let parsedProgress = this.parseProgress(stringData);
            
            if(parsedProgress)
                execEventEmitter.emit("progress", parsedProgress);

            execEventEmitter.emit("stdout", stringData);
        });

        let stderrData = "";
        youtubeDlProcess.stderr.on("data", (data) => 
        {
            let stringData = data.toString();
            stderrData += stringData;
            execEventEmitter.emit("stderr", stringData);
        });

        let processError = "";
        youtubeDlProcess.on("error", (error) => {
            processError = error;
        });
        youtubeDlProcess.on("close", (code) => {
            if(code === 0)
                execEventEmitter.emit("close", code);
            else
                execEventEmitter.emit("error", code, processError, stderrData);
        });

        return execEventEmitter;
    }

    execPromise(youtubeDlArguments = [], options = {})
    {
        return new Promise( (resolve, reject) => 
        {
            options = this.setDefaultOptions(options);
            execFile(this.binaryPath, youtubeDlArguments, options, (error, stdout, stderr) =>
            {
                if(error)
                    reject({processError: error, stderr: stderr});
                resolve(stdout);
            });
        });
    }

    execStream(youtubeDlArguments = [], options = {})
    {
        const readStream = new Readable();
        options = this.setDefaultOptions(options);
        youtubeDlArguments = youtubeDlArguments.concat(["-o", "-"]);
        readStream._read = function(){};
        const youtubeDlProcess = spawn(this.binaryPath, youtubeDlArguments, options);

        let processError = "";
        let stderrData = "";
        youtubeDlProcess.stdout.on("data", (data) => readStream.push(data));
        youtubeDlProcess.stderr.on("data", (data) => stderrData += data.toString());
        youtubeDlProcess.on("error", (error) => processError = error );
        youtubeDlProcess.on("close", (code) => {
            readStream.destroy(code == 0 ? false : "error - " + code + " - " + processError + " - " + stderrData);
        });
        return readStream;
    }

    parseProgress(progressLine)
    {
        let progressMatch = progressLine.match(this.progressRegex);
        if(progressMatch == null)
            return null;
        
        let progressObject = {};
        progressObject.percent = parseFloat(progressMatch[1].replace("%", ""));
        progressObject.totalSize = progressMatch[2].replace("~", "");
        progressObject.currentSpeed = progressMatch[3];
        progressObject.eta = progressMatch[4];
        return progressObject;
    }

}

module.exports = YoutubeDlWrap;
