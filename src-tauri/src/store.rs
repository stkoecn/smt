//! smt.yaml 持久化（权威任务模型 + UI 设置）。
//!
//! 配置优先存放在与可执行文件同层级的 `smt.yaml`（便携模式）；
//! 兼容旧版 `tasks.json`：首次发现时自动迁移为 YAML，旧文件保留不动。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use smt_core::TaskTree;

const YAML_NAME: &str = "smt.yaml";
const LEGACY_JSON_NAME: &str = "tasks.json";

/// 单文件配置：任务树 + 通用设置（字符串键值，前端 UI 偏好等）。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SmtConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tasks: Option<TaskTree>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    settings: HashMap<String, String>,
}

impl SmtConfig {
    fn tasks(&self) -> &TaskTree {
        self.tasks.as_ref().expect("tasks 恒被初始化")
    }
    fn tasks_mut(&mut self) -> &mut TaskTree {
        self.tasks.get_or_insert_with(TaskTree::default)
    }
}

/// 首次运行种子：一个文件夹 + 文件服务器示例任务。
fn seed_tree() -> TaskTree {
    let mut tree = TaskTree::default();
    let folder_id = "folder-web-services";
    let _ = tree.create_folder(folder_id, "Web 服务", None::<String>);
    let _ = tree.create_task(
        "task-file-server",
        smt_core::TaskInput {
            name: "file-server".to_string(),
            folder_id: Some(folder_id.to_string()),
            command: "python -m http.server 8000".to_string(),
            workdir: None,
            env: Default::default(),
            auto_start: false,
            auto_attach: true,
            save_log: false,
            shell: None,
            run_as_admin: false,
            dependencies: vec![],
            wait_for_deps: false,
            dep_delay_secs: 5,
        },
    );
    tree
}

/// 读取 YAML 配置（损坏时返回 None，调用方回退种子）。
fn load_yaml(path: &Path) -> Option<SmtConfig> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_yaml_ng::from_str::<SmtConfig>(&s).ok())
        .filter(|c| c.tasks.is_some())
}

pub struct TaskStore {
    path: PathBuf,
    config: Mutex<SmtConfig>,
}

impl TaskStore {
    pub fn init(dir: PathBuf) -> Self {
        let path = dir.join(YAML_NAME);
        let mut config = if path.exists() {
            load_yaml(&path).unwrap_or_else(|| {
                let mut c = SmtConfig::default();
                c.tasks = Some(seed_tree());
                c
            })
        } else {
            // YAML 不存在 → 尝试迁移旧版 tasks.json
            let legacy = dir.join(LEGACY_JSON_NAME);
            let mut c = if legacy.exists() {
                fs::read_to_string(&legacy)
                    .ok()
                    .and_then(|s| serde_json::from_str::<TaskTree>(&s).ok())
                    .map(|t| SmtConfig {
                        tasks: Some(t),
                        settings: HashMap::new(),
                    })
                    .unwrap_or_default()
            } else {
                SmtConfig::default()
            };
            if c.tasks.is_none() {
                c.tasks = Some(seed_tree()); // 损坏/缺失 → 播种
            }
            let _ = fs::create_dir_all(&dir);
            c
        };
        // 旧数据可能没有 order 字段：归一化后顺序即文件顺序；
        // 同时保证每次加载后兄弟 group 内 order 连续。
        if let Some(t) = &mut config.tasks {
            t.normalize();
        }
        let store = Self {
            path,
            config: Mutex::new(config),
        };
        let _ = store.save_yaml();
        store
    }

    fn save_yaml(&self) -> Result<(), String> {
        let json = serde_yaml_ng::to_string(&*self.config.lock().unwrap())
            .map_err(|e| format!("YAML 序列化失败: {e}"))?;
        let tmp_path = self.path.with_extension("tmp");
        fs::write(&tmp_path, &json).map_err(|e| format!("写入临时配置文件失败: {e}"))?;
        if let Err(e) = fs::rename(&tmp_path, &self.path) {
            // Windows 备用回退：若 rename 遇到目标文件锁或特殊错误，尝试直接覆写并清理 tmp
            if let Err(e2) = fs::write(&self.path, &json) {
                let _ = fs::remove_file(&tmp_path);
                return Err(format!("更新配置文件失败: {e} (回退覆写失败: {e2})"));
            }
            let _ = fs::remove_file(&tmp_path);
        }
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn tree(&self) -> TaskTree {
        self.config.lock().unwrap().tasks().clone()
    }

    pub fn mutate<R>(
        &self,
        f: impl FnOnce(&mut TaskTree) -> Result<R, smt_core::TreeError>,
    ) -> Result<R, String> {
        let mut c = self.config.lock().unwrap();
        let result = f(c.tasks_mut()).map_err(|e| e.to_string())?;
        drop(c);
        self.save_yaml()?;
        Ok(result)
    }

    pub fn settings(&self) -> HashMap<String, String> {
        self.config.lock().unwrap().settings.clone()
    }

    pub fn save_settings(&self, settings: HashMap<String, String>) -> Result<(), String> {
        let mut c = self.config.lock().unwrap();
        c.settings.extend(settings);
        drop(c);
        self.save_yaml()
    }
}

/// Global accessor for the task store (set up once in `setup`).
/// The store is leaked for a 'static lifetime — it lives for the whole app.
static STORE: OnceLock<&'static TaskStore> = OnceLock::new();

pub fn init_store(dir: PathBuf) {
    let store: &'static TaskStore = Box::leak(Box::new(TaskStore::init(dir)));
    let _ = STORE.set(store);
}

pub fn store() -> &'static TaskStore {
    *STORE.get().expect("TaskStore not initialized")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("smt-store-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn yaml_roundtrip_persists_tree_and_settings() {
        let dir = temp_dir("roundtrip");
        let store = TaskStore::init(dir.clone());
        store
            .mutate(|t| t.create_folder("f1", "新建", None::<String>).map(|_| ()))
            .unwrap();
        store
            .save_settings([("theme".to_string(), "dark".to_string())].into_iter().collect())
            .unwrap();

        // 重新加载：等价于应用重启
        let again = TaskStore::init(dir.clone());
        assert!(again.tree().folder("f1").is_some());
        assert_eq!(again.settings().get("theme").map(String::as_str), Some("dark"));

        // 文件是 YAML 且含 tasks + settings 两个节
        let yaml = fs::read_to_string(dir.join(YAML_NAME)).unwrap();
        assert!(yaml.contains("tasks:"));
        assert!(yaml.contains("settings:"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn legacy_json_is_migrated_to_yaml() {
        let dir = temp_dir("legacy");
        let mut tree = TaskTree::default();
        tree.create_task(
            "t1",
            smt_core::TaskInput {
                name: "x".to_string(),
                folder_id: None,
                command: "echo hi".to_string(),
                workdir: None,
                env: Default::default(),
                auto_start: false,
                auto_attach: true,
                save_log: false,
                shell: None,
                run_as_admin: false,
                dependencies: vec![],
                wait_for_deps: false,
                dep_delay_secs: 5,
            },
        )
        .unwrap();
        fs::write(dir.join(LEGACY_JSON_NAME), serde_json::to_string(&tree).unwrap()).unwrap();

        let store = TaskStore::init(dir.clone());
        assert!(store.tree().task("t1").is_some());
        // 迁移后生成 YAML；旧 JSON 保留不动
        assert!(dir.join(YAML_NAME).exists());
        assert!(dir.join(LEGACY_JSON_NAME).exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}