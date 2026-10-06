pub mod audit;
pub mod audit_search;
pub mod grounding;
pub mod links;
pub mod policy;
pub mod query;
pub mod retrieval;
pub mod tasks;
pub mod workspace;

use serde_json::Value;

pub fn dispatch(operation: &str, input: Value) -> Result<Value, String> {
    match operation {
        "core.version" => Ok(Value::String(env!("CARGO_PKG_VERSION").into())),
        op if op.starts_with("retrieval.") => retrieval::dispatch(op, input),
        op if op.starts_with("policy.") => policy::dispatch(op, input),
        op if op.starts_with("links.") => links::dispatch(op, input),
        op if op.starts_with("tasks.") => tasks::dispatch(op, input),
        op if op.starts_with("query.") => query::dispatch(op, input),
        op if op.starts_with("audit.") => audit::dispatch(op, input),
        op if op.starts_with("grounding.") => grounding::dispatch(op, input),
        op if op.starts_with("workspace.") => workspace::dispatch(op, input),
        op if op.starts_with("auditSearch.") => audit_search::dispatch(op, input),
        _ => Err(format!("Unknown core operation: {operation}")),
    }
}

#[cfg(feature = "node")]
pub mod node {
    use super::*;
    use napi::{bindgen_prelude::AsyncTask, Env, Task};
    use napi_derive::napi;
    use std::sync::{Arc, RwLock};

    fn parse(input: &str) -> napi::Result<Value> {
        serde_json::from_str(input)
            .map_err(|error| napi::Error::from_reason(format!("Invalid core input: {error}")))
    }

    fn encode(output: Result<Value, String>) -> napi::Result<String> {
        let value = output.map_err(napi::Error::from_reason)?;
        serde_json::to_string(&value).map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    #[napi]
    pub fn invoke(operation: String, input: String) -> napi::Result<String> {
        encode(dispatch(&operation, parse(&input)?))
    }

    #[napi]
    #[derive(Default)]
    pub struct NativeIndex {
        index: Arc<RwLock<retrieval::Index>>,
    }

    #[napi]
    impl NativeIndex {
        #[napi(constructor)]
        pub fn new() -> Self {
            Self::default()
        }

        #[napi]
        pub fn execute(&mut self, operation: String, input: String) -> napi::Result<String> {
            let mut index = self
                .index
                .write()
                .map_err(|_| napi::Error::from_reason("Index lock poisoned"))?;
            encode(index.execute(&operation, parse(&input)?))
        }

        #[napi]
        pub fn search_async(&self, input: String) -> napi::Result<AsyncTask<SearchTask>> {
            Ok(AsyncTask::new(SearchTask {
                index: Arc::clone(&self.index),
                input: parse(&input)?,
            }))
        }
    }

    #[napi]
    #[derive(Default)]
    pub struct NativePolicy {
        policy: policy::PolicyStore,
    }

    #[napi]
    impl NativePolicy {
        #[napi(constructor)]
        pub fn new() -> Self {
            Self::default()
        }

        #[napi]
        pub fn execute(&mut self, operation: String, input: String) -> napi::Result<String> {
            encode(self.policy.execute(&operation, parse(&input)?))
        }
    }

    pub struct SearchTask {
        index: Arc<RwLock<retrieval::Index>>,
        input: Value,
    }

    impl Task for SearchTask {
        type Output = String;
        type JsValue = String;

        fn compute(&mut self) -> napi::Result<String> {
            let index = self
                .index
                .read()
                .map_err(|_| napi::Error::from_reason("Index lock poisoned"))?;
            encode(index.search(&self.input))
        }

        fn resolve(&mut self, _: Env, output: String) -> napi::Result<String> {
            Ok(output)
        }
    }
}
