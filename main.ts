import { FolderSuggest } from "Suggest/FolderSuggest";
import { App, Plugin, PluginSettingTab, Setting, TFile, TFolder } from "obsidian";

interface ArchiveConfig {
	sourceFolder: string;
	destFolder: string;
	maintainFolderStructure: boolean;
	deleteEmptyFolders: boolean;
	days: number;
}

interface AutoArchivePluginSettings {
	archiveConfigs: ArchiveConfig[];
}

const DEFAULT_SETTINGS: AutoArchivePluginSettings = {
	archiveConfigs: [],
};

const MIN_DAYS = 1; // Min. value for `days` setting
const INITIAL_PROCESS_WAIT_MS = 10 * 1000; // Wait before first process
const PROCESS_INTERVAL_MS = 60 * 1000; // Interval to process files
const NUM_MS_IN_DAY = 86400000;

export default class AutoArchivePlugin extends Plugin {
	settings: AutoArchivePluginSettings;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new AutoArchiveSettingTab(this.app, this));

		// Wait a bit before first process to give Obsidian time to load files
		this.registerInterval(
			window.setTimeout(this.processVault.bind(this), INITIAL_PROCESS_WAIT_MS)
		);
		
		// Process all relevant files at regular interval
		this.registerInterval(
			window.setInterval(this.processVault.bind(this), PROCESS_INTERVAL_MS)
		);
	}

	getValidArchiveConfigs(): ArchiveConfig[] {
		return this.settings.archiveConfigs
		.filter((config) => config.sourceFolder.trim().length > 0 && config.destFolder.trim().length > 0);
	}

	doesFileBelongToArchiveConfig(file: TFile, archiveConfig: ArchiveConfig): boolean {
		return file.path.startsWith(archiveConfig.sourceFolder);
	}

	async processVault(): Promise<void> {
		const archiveConfigs = this.getValidArchiveConfigs();

		// Process every user-configured archive
		for (const archiveConfig of archiveConfigs) {
			const sourceFolder = await this.app.vault.getAbstractFileByPath(archiveConfig.sourceFolder);

			if (sourceFolder instanceof TFolder) {
				const sourceFiles = this.getMarkdownFilesInFolderRecursive(sourceFolder);

				// Process each file in this config's source folder
				for (const sourceFile of sourceFiles) {
					await this.processSourceFile(sourceFile, archiveConfig);
				}
			} else {
				console.warn(`Auto Archive: Configured source [${sourceFolder?.path}] is not a folder`);
			}
		}
	}

	/**
	 * Evaluates a file in a configured source folder, archiving it if necessary.
	 * 
	 * @param sourceFile 
	 * @param archiveConfig 
	 */
	async processSourceFile(sourceFile: TFile, archiveConfig: ArchiveConfig): Promise<void> {
		if (this.shouldFileBeArchived(sourceFile, archiveConfig)) {
			// Construct path for file in archive
			let newFilePath = archiveConfig.destFolder;

			if (archiveConfig.maintainFolderStructure) {
				const filePathInSourceFolder = this.getFilePathInSourceFolder(sourceFile, archiveConfig);
				newFilePath = this.joinPaths(newFilePath, filePathInSourceFolder);

				// Source folder structure may not exist in archive folder.
				await this.createFoldersInPath(newFilePath);
			} else {
				newFilePath = this.joinPaths(newFilePath, sourceFile.name);
			}

			const existingArchiveFile = this.app.vault.getAbstractFileByPath(newFilePath);
			if (existingArchiveFile != null) {
				await this.app.vault.delete(existingArchiveFile);
			}

			await this.copyFile(sourceFile, newFilePath);
			await this.app.vault.delete(sourceFile);

			if (archiveConfig.deleteEmptyFolders) {
				await this.deleteEmptyFolders(sourceFile, archiveConfig);
			}
		}
	}

	getMarkdownFilesInFolderRecursive(folder: TFolder): TFile[] {
		const files: TFile[] = [];

		for (const child of folder.children) {
			if (child instanceof TFile && child.name.endsWith(".md")) {
				files.push(child)
			} else if (child instanceof TFolder) {
				files.push(...this.getMarkdownFilesInFolderRecursive(child));
			}
		}

		return files;
	}

	/**
	 * Determines whether the given file is due for archival.
	 * 
	 * @param sourceFile 
	 * @param archiveConfig 
	 * @returns true if the file should be archived
	 */
	shouldFileBeArchived(sourceFile: TFile, archiveConfig: ArchiveConfig): boolean {
		const today = new Date();
		const createdDate = new Date(sourceFile.stat.ctime);
		const cutoffDate = new Date(today.getTime() - NUM_MS_IN_DAY * archiveConfig.days);
		
		return createdDate < cutoffDate;
	}

	/**
	 * Given a file that was just archived, deletes all empty sub-folders of the source folder
	 * leading up to it. This should be used with the `deleteEmptyFolders` setting.
	 * 
	 * Example: If a file `DailyNotes/2023/December/31.md` in a source folder `DailyNotes` was just archived and
	 * `2023` and `December` are now empty, then both of those folders will be deleted.
	 * `DailyNotes` will remain.
	 * 
	 * @param deletedFile 
	 * @param archiveConfig 
	 */
	async deleteEmptyFolders(deletedFile: TFile, archiveConfig: ArchiveConfig) {
		const filePathInSourceFolder = this.getFilePathInSourceFolder(deletedFile, archiveConfig);

		// Folder of source file WITHOUT the source folder itself.
		// Ex. a file "Notes/2023/mynote.md" in a source folder "Notes" will produce "2023".
		const sourceFileFolderPath = this.getFolderFromPath(filePathInSourceFolder);

		const folderPathParts = this.splitPathString(sourceFileFolderPath);

		// Walk backwards through the folders leading up to the moved file's old location,
		// excluding the source folder and its parents.
		// If any of the folders are now empty, delete them.
		// This is done so that you aren't left with a bunch of empty folders for past weeks/months, etc.
		if (folderPathParts.length > 0) {
			const numPathParts = folderPathParts.length;

			for (let i = 0; i < numPathParts; i++) {
				const currDirPath = this.joinPaths(archiveConfig.sourceFolder, folderPathParts.join("/"));
				const abstractFolder = this.app.vault.getAbstractFileByPath(currDirPath);

				if (abstractFolder instanceof TFolder && abstractFolder.children.length === 0) {
					// Folder is empty
					await this.app.vault.delete(abstractFolder, true);
				}

				folderPathParts.pop();
			}
		}
	}

	/**
	 * Joins two paths, e.g. `joinPaths("source", "folder")` returns "source/folder".
	 * 
	 * @param p1 
	 * @param p2 
	 * @returns joined path
	 */
	joinPaths(p1: string, p2: string): string {
		let p1Trimmed = p1.trim();
		while (p1Trimmed.endsWith("/")) {
			p1Trimmed = p1Trimmed.slice(0, p1Trimmed.length - 1);
		}

		let p2Trimmed = p2.trim();
		while (p2Trimmed.startsWith("/")) {
			p2Trimmed = p2Trimmed.slice(1);
		}
		while (p2Trimmed.endsWith("/")) {
			p2Trimmed = p2Trimmed.slice(0, p2Trimmed.length - 1);
		}

		if (p1Trimmed.length === 0 && p2Trimmed.length === 0) {
			return "";
		} else if (p1Trimmed.length === 0) {
			return p2Trimmed;
		} else if (p2Trimmed.length === 0) {
			return p1Trimmed;
		}

		return p1Trimmed + "/" + p2Trimmed;
	}

	/**
	 * If file path is `Notes/2023/mynote.md` in a source folder `Notes`, produces `2023/mynote.md`.
	 * 
	 * @param sourceFile 
	 * @param archiveConfig 
	 * @returns file path
	 */
	getFilePathInSourceFolder(sourceFile: TFile, archiveConfig: ArchiveConfig) {
		return sourceFile.path.replace(archiveConfig.sourceFolder, "")
	}

	/**
	 * Splits a file path into an array of its parts (folders or files).
	 * 
	 * @param path 
	 * @returns split path
	 */
	splitPathString(path: string): string[] {
		return path.split("/").filter((segment) => segment.length > 0)
	}

	/**
	 * If a folder path is given, it's returned as-is.
	 * If a file path is given, the folder path leading up to it is returned.
	 * If a file path is given with no preceding folders, an empty string is returned.
	 * 
	 * @param fileOrFolderPath
	 * @returns folder path
	 */
	getFolderFromPath(fileOrFolderPath: string): string {
		if (!fileOrFolderPath.endsWith(".md")) {
			// Already a folder path
			return fileOrFolderPath;
		}

		if (!fileOrFolderPath.contains("/")) {
			// Just a file name
			return "";
		}

		return fileOrFolderPath.slice(0, fileOrFolderPath.lastIndexOf("/"));
	}

	/**
	 * Copies a file to a new location.
	 * 
	 * @param file 
	 * @param newFilePath 
	 */
	async copyFile(file: TFile, newFilePath: string) {
		try {
			await this.app.vault.copy(file, newFilePath);
		} catch (e) {
			// Nothing - produces random "destination file already exists" errors
		}
	}

	/**
	 * Given a file or folder path, creates all folders in the path.
	 * 
	 * @param fileOrFolderPath File or folder path
	 */
	async createFoldersInPath(fileOrFolderPath: string) {
		try {
			// This creates all folders in the path.
			await this.app.vault.createFolder(this.getFolderFromPath(fileOrFolderPath));
		} catch (e) {
			// Nothing - folder already exists
		}
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class AutoArchiveSettingTab extends PluginSettingTab {
	plugin: AutoArchivePlugin;

	constructor(app: App, plugin: AutoArchivePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h1", { text: "Configurations" });

		this.plugin.settings.archiveConfigs.forEach((config, i) => {
			containerEl.createEl("h2", { text: `Configuration ${i + 1}`, cls: "aa-h2" });

			new Setting(containerEl)
				.setName("Source Folder")
				.setDesc("Archive notes from this folder")
				.addSearch((cb) => {
					new FolderSuggest(cb.inputEl),
						cb
							.setPlaceholder("Example: work/notes")
							.setValue(config.sourceFolder)
							.onChange((newFolder) => {
								config.sourceFolder = newFolder;
								this.plugin.saveSettings();
							});
				})
				.setClass("aa-folder-search");

			new Setting(containerEl)
				.setName("Archive Folder")
				.setDesc("Move notes to this folder")
				.addSearch((cb) => {
					new FolderSuggest(cb.inputEl),
						cb
							.setPlaceholder("Example: work/note_archive")
							.setValue(config.destFolder)
							.onChange((newFolder) => {
								config.destFolder = newFolder;
								this.plugin.saveSettings();
							});
				})
				.setClass("aa-folder-search");

			new Setting(containerEl)
				.setName("Maintain Folder Structure")
				.setDesc("Maintain the source folder's hierarchy in the archive?")
				.addToggle((cb) => {
					cb
						.setValue(config.maintainFolderStructure)
						.onChange((value) => {
							config.maintainFolderStructure = value;
							this.plugin.saveSettings();
						});
				});

				new Setting(containerEl)
				.setName("Auto-Delete Empty Folders")
				.setDesc("Delete folders from which all notes have been archived?")
				.addToggle((cb) => {
					cb
						.setValue(config.deleteEmptyFolders)
						.onChange((value) => {
							config.deleteEmptyFolders = value;
							this.plugin.saveSettings();
						});
				});

			new Setting(containerEl)
				.setName("Archive After X Days")
				.setDesc("Age of note in days when archival will occur")
				.addText((cb) => {
					// On blur, reset input value to config
					// (Non-numbers stripped out and empty value replaced)
					cb.inputEl.addEventListener("blur", () => {
						cb.setValue(config.days.toString());
					});

					cb
						.setValue(config.days.toString())
						.onChange((value) => {
							// Strip out non-numbers
							const numbersOnly = value.replace(/[^0-9]+/g, "");
							let newDays = Number(numbersOnly);
							
							if (newDays === 0) {
								newDays = MIN_DAYS;
							}

							config.days = newDays;
							this.plugin.saveSettings();
						});
				});

			new Setting(containerEl).addButton((cb) => {
				cb.setButtonText("Delete Config")
					.setClass("aa-delete-btn")
					.onClick(() => {
						this.plugin.settings.archiveConfigs.splice(i, 1);
						this.plugin.saveSettings();
						this.display();
					});
			});
		});

		new Setting(containerEl).addButton((cb) => {
			cb.setButtonText("Add Archive Config")
				.setCta()
				.setClass("aa-new-config-btn")
				.onClick(() => {
					this.plugin.settings.archiveConfigs.push({
						sourceFolder: "",
						destFolder: "",
						maintainFolderStructure: true,
						deleteEmptyFolders: true,
						days: 30
					});
					this.plugin.saveSettings();
					this.display();
				});
		});
	}
}
