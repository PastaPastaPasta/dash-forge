use serde_json::{json, Value};

use super::*;

/// The vector's spec (a JSON object), read as `board.spec` would be.
fn spec_of(v: &Value) -> BoardSpec {
    parse_spec(&serde_json::to_string(v).unwrap()).expect("vector spec parses")
}

fn de<T: serde::de::DeserializeOwned>(v: &Value) -> T {
    serde_json::from_value(v.clone()).unwrap()
}

fn rank_json(r: Result<String, RankError>) -> Value {
    match r {
        Ok(rank) => json!({ "rank": rank }),
        Err(e) => json!({ "error": e.as_str() }),
    }
}

fn opt_str(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

/// The fold a vector describes, and its spec and items.
fn fold_of(inp: &Value) -> (BoardSpec, Vec<BoardItem>, BoardFold) {
    let spec = spec_of(&inp["spec"]);
    let items: Vec<BoardItem> = de(&inp["items"]);
    let cards: Vec<CardDoc> = de(&inp["cards"]);
    let fold = fold_board(
        &spec,
        inp["home"].as_str().unwrap(),
        &items,
        &cards,
        inp["now"].as_i64().unwrap(),
    );
    (spec, items, fold)
}

/// The rows a view vector's query (`q`) keeps, in input order.
fn rows_of<'a>(
    inp: &Value,
    spec: &BoardSpec,
    items: &'a [BoardItem],
    fold: &'a BoardFold,
) -> Vec<BoardRow<'a>> {
    let query = parse_board_query(inp["q"].as_str().unwrap_or(""), spec);
    let ctx = QueryContext {
        me: opt_str(&inp["me"]),
        now: inp["now"].as_i64().unwrap(),
    };
    items
        .iter()
        .zip(&fold.items)
        .map(|(item, placement)| BoardRow { item, placement })
        .filter(|r| matches_board_query(r.item, r.placement, spec, &query, &ctx))
        .collect()
}

#[allow(clippy::too_many_lines)] // one arm per case and op
fn run(case: &str, inp: &Value) -> Value {
    let op = inp["op"].as_str().unwrap();
    match (case, op) {
        ("board_spec", "parse") => inp["cases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| match parse_spec(c["json"].as_str().unwrap()) {
                Ok(spec) => json!({ "name": c["name"], "json": serialize_spec(&spec).unwrap() }),
                Err(e) => json!({ "name": c["name"], "error": e.as_str() }),
            })
            .collect(),
        ("board_spec", "default") => {
            let spec = default_spec(inp["home"].as_str().unwrap(), inp["now"].as_i64().unwrap());
            json!({ "json": serialize_spec(&spec).unwrap() })
        }
        ("board_spec", "values") => {
            let spec = spec_of(&inp["spec"]);
            let values = parse_field_values(inp["f"].as_str(), &spec);
            match serialize_field_values(&values, &spec) {
                Some(j) => json!({ "values": values, "json": j }),
                None => json!({ "values": values, "error": "size" }),
            }
        }
        ("board_rank", "between") => inp["pairs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| rank_between(p[0].as_str().unwrap_or(""), p[1].as_str().unwrap_or("")))
            .map(rank_json)
            .collect(),
        ("board_rank", "top") => inp["firsts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| rank_json(top_rank(f.as_str())))
            .collect(),
        ("board_rank", "bottom") => inp["lasts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| rank_json(bottom_rank(l.as_str())))
            .collect(),
        ("board_rank", "implicit") => inp["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| {
                json!(implicit_rank_of(
                    i["createdAt"].as_i64().unwrap(),
                    i["id"].as_str().unwrap()
                ))
            })
            .collect(),
        ("board_rank", "rerank") => match rerank(inp["n"].as_u64().unwrap()) {
            Ok(ranks) => json!({ "ranks": ranks }),
            Err(e) => json!({ "error": e.as_str() }),
        },
        ("board_fold", "fold") => serde_json::to_value(fold_of(inp).2).unwrap(),
        ("board_fold", "boards") => {
            let docs: Vec<BoardDoc> = de(&inp["docs"]);
            newest_boards(&docs, inp["withDeleted"].as_bool().unwrap_or(false))
                .iter()
                .map(|d| json!({ "key": d.key, "id": d.id, "state": d.state }))
                .collect()
        }
        ("board_query", "parse") => {
            let spec = spec_of(&inp["spec"]);
            serde_json::to_value(parse_board_query(inp["text"].as_str().unwrap(), &spec)).unwrap()
        }
        ("board_query", "source") => {
            let spec = spec_of(&inp["spec"]);
            serde_json::to_value(parse_source_query(inp["text"].as_str().unwrap(), &spec)).unwrap()
        }
        ("board_query", "match") => {
            let (spec, items, fold) = fold_of(inp);
            inp["texts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|text| {
                    let mut q = inp.clone();
                    q["q"] = text.clone();
                    rows_of(&q, &spec, &items, &fold)
                        .iter()
                        .map(|r| json!(r.item.id))
                        .collect::<Value>()
                })
                .collect()
        }
        ("board_iteration", "at" | "range") => {
            let spec = spec_of(&inp["spec"]);
            let field = spec
                .field(u8::try_from(inp["field"].as_u64().unwrap()).unwrap())
                .unwrap();
            if op == "at" {
                inp["dates"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|d| json!(iteration_at(field, d.as_i64().unwrap())))
                    .collect()
            } else {
                inp["ks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|k| {
                        serde_json::to_value(iteration_range(field, k.as_i64().unwrap())).unwrap()
                    })
                    .collect()
            }
        }
        ("board_view", _) => {
            let (spec, items, fold) = fold_of(inp);
            let rows = rows_of(inp, &spec, &items, &fold);
            let field_id = |k: &str| inp[k].as_u64().map(|x| u8::try_from(x).unwrap());
            match op {
                "group" => serde_json::to_value(group_rows(
                    &rows,
                    inp["by"].as_str().unwrap(),
                    &spec,
                    inp["now"].as_i64().unwrap(),
                ))
                .unwrap(),
                "sort" => inp["sorts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|sort| {
                        sort_rows(&rows, sort.as_str(), &spec)
                            .iter()
                            .map(|r| json!(r.item.id))
                            .collect::<Value>()
                    })
                    .collect(),
                "totals" => {
                    let view =
                        field_id("view").and_then(|id| spec.views.iter().find(|v| v.id == id));
                    serde_json::to_value(column_totals(&rows, &spec, sum_field_of(&spec, view)))
                        .unwrap()
                }
                "progress" => serde_json::to_value(iteration_progress(
                    &rows,
                    &spec,
                    field_id("field").unwrap(),
                    inp["k"].as_i64().unwrap(),
                    field_id("points"),
                ))
                .unwrap(),
                other => panic!("unknown board_view op `{other}`"),
            }
        }
        _ => panic!("unknown board vector `{case}` op `{op}`"),
    }
}

/// Every `board_*__*.json` vector, the same as forge-web `lib/rules/boards.conformance.test.ts`
/// runs.
#[test]
fn board_vectors() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../forge-contracts/vectors");
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(VECTOR_CASE_PREFIX)
        })
        .collect();
    files.sort();
    let mut cases = std::collections::BTreeSet::new();
    for path in &files {
        let v: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let case = v["case"].as_str().unwrap();
        let name = path.file_name().unwrap().to_string_lossy();
        assert!(
            name.starts_with(&format!("{case}__")),
            "{name}: file is <case>__<name>.json"
        );
        cases.insert(case.to_string());
        let got = run(case, &v["input"]);
        assert_eq!(got, v["expected"], "vector {name}");
    }
    for c in [
        "board_rank",
        "board_spec",
        "board_fold",
        "board_query",
        "board_iteration",
        "board_view",
    ] {
        assert!(cases.contains(c), "no {c} vectors");
    }
    assert!(files.len() >= 30, "ran {} board vectors", files.len());
    println!("board_vectors: {} green", files.len());
}

/// A deterministic PRNG (splitmix64), the same as `boards.test.ts` uses.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: u64) -> usize {
        usize::try_from(self.next() % n).unwrap()
    }

    /// 0–`max` rank digits, biased to `0`, `1`, `y`, `z` and short strings (the edges).
    fn digits(&mut self, max: u64) -> String {
        let len = self.below(max + 1);
        (0..len)
            .map(|_| match self.below(4) {
                0 => char::from(b"01yz"[self.below(4)]),
                _ => char::from(RANK_DIGITS[self.below(62)]),
            })
            .collect()
    }
}

/// Whether nothing lies strictly between `a` < `b`: `b` is `a` and only `0`s.
fn nothing_between(a: &str, b: &str) -> bool {
    b.len() > a.len() && b.starts_with(a) && b[a.len()..].bytes().all(|c| c == b'0')
}

fn check_between(a: &str, b: &str) {
    match rank_between(a, b) {
        Ok(r) => {
            assert!(a < r.as_str(), "{a:?} < {r:?}");
            assert!(b.is_empty() || r.as_str() < b, "{r:?} < {b:?}");
            assert!(is_explicit_rank(&r), "{r:?} is an explicit rank");
            assert!(r.len() <= a.len().max(b.len()) + 1, "{r:?} is short");
        }
        Err(e) => {
            let too_long = a.len().max(b.len()) >= RANK_MAX;
            assert!(
                e == RankError::Rerank && (nothing_between(a, b) || too_long),
                "{a:?} {b:?}: {e:?}"
            );
        }
    }
}

#[test]
fn rank_between_is_strictly_between() {
    let mut rng = Rng(0x00b0_a2d5);
    for _ in 0..20_000 {
        let (x, y) = (rng.digits(6), rng.digits(6));
        // half the pairs share a prefix, so prefix relations (`V` / `V1` / `V10`) are common
        let (x, y) = if rng.below(2) == 0 {
            let p = rng.digits(4);
            (format!("{p}{x}"), format!("{p}{y}"))
        } else {
            (x, y)
        };
        match x.cmp(&y) {
            Ordering::Less => check_between(&x, &y),
            Ordering::Greater => check_between(&y, &x),
            Ordering::Equal if x.is_empty() => assert_eq!(rank_between("", "").as_deref(), Ok("V")),
            Ordering::Equal => assert_eq!(rank_between(&x, &y), Err(RankError::Rerank)),
        }
        check_between(&x, "");
        if !x.is_empty() {
            check_between("", &x);
        }
    }
    // the pool: implicit ranks may end in `0`
    for (a, b) in [
        ("V", "V0"),
        ("V1", "V10"),
        ("V1", "V100"),
        ("V10", "V1000"),
        ("", "0"),
        ("", "00"),
    ] {
        assert_eq!(rank_between(a, b), Err(RankError::Rerank), "{a} {b}");
    }
    assert_eq!(rank_between("V1", "V101").as_deref(), Ok("V100V"));
    assert_eq!(rank_between("V", "V01").as_deref(), Ok("V00V"));
}

#[test]
fn repeated_drops_into_one_gap_end_in_rerank() {
    // always dropping just below the last drop: each halves the gap
    let (mut lo, mut hi) = (String::new(), "V".to_string());
    let mut drops = 0;
    while let Ok(r) = rank_between(&lo, &hi) {
        hi = r;
        drops += 1;
        assert!(drops < 1000);
    }
    assert!((300..=400).contains(&drops), "{drops} drops");
    // and just above it
    hi = String::new();
    lo = "V".to_string();
    drops = 0;
    while let Ok(r) = rank_between(&lo, &hi) {
        lo = r;
        drops += 1;
        assert!(drops < 20_000);
    }
    assert!(drops > 300, "{drops} drops");
}

#[test]
fn rerank_spreads_below_the_pool() {
    for n in [0_u64, 1, 2, 3, 30, 31, 100, 1921, 1922, 5000] {
        let ranks = rerank(n).unwrap();
        assert_eq!(ranks.len(), usize::try_from(n).unwrap());
        for w in ranks.windows(2) {
            assert!(w[0] < w[1]);
            assert!(rank_between(&w[0], &w[1]).is_ok());
        }
        assert!(ranks
            .iter()
            .all(|r| is_explicit_rank(r) && r.as_str() < "V"));
    }
    assert_eq!(rerank(RERANK_MAX + 1), Err(RankError::Invalid));
}

#[test]
fn spec_round_trips_and_defaults_fit() {
    let spec = default_spec(
        "4tJ7mVo5yJm4b6rKZ2SRsG6YqfJHFDLC2kUwD3nAhZ7b",
        1_761_782_400_000,
    );
    let json = serialize_spec(&spec).unwrap();
    assert_eq!(parse_spec(&json).unwrap(), spec);
    assert_eq!(serialize_spec(&parse_spec(&json).unwrap()).unwrap(), json);
    assert!(json.len() <= SPEC_MAX_BYTES);
}

#[test]
fn dates_and_mondays() {
    assert_eq!(date_days("1970-01-01"), Some(0));
    assert_eq!(date_days("2024-02-29"), Some(19_782));
    assert_eq!(date_days("2023-02-29"), None);
    assert_eq!(civil_from_days(19_782), "2024-02-29");
    assert_eq!(monday_of(0), "1969-12-29");
    // 2026-10-27 is a Tuesday
    assert_eq!(
        monday_of(date_days("2026-10-27").unwrap() * DAY_MS + 5),
        "2026-10-26"
    );
    assert_eq!(
        monday_of(date_days("2026-10-26").unwrap() * DAY_MS),
        "2026-10-26"
    );
    for d in [-719_162_i64, -700_000, -1, 0, 59, 60, 10_000, 2_932_896] {
        assert_eq!(date_days(&civil_from_days(d)), Some(d));
    }
}
