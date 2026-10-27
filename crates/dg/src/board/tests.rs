//! `dg board`'s argument parsing and the definitions it creates, offline.

use clap::Parser as _;

use super::*;
use crate::Cli;

const HOME: &str = "4X5xgudNAwLhWEL3jgsisYszZXPnf33VbyaAqjbUB9Yi";

#[test]
fn an_item_is_a_number_a_repo_and_number_or_a_kind_and_number() {
    let a = |s: &str| parse_item_arg(s).unwrap();
    let item = |kind, repo: Option<&str>, number| ItemArg {
        kind,
        repo: repo.map(str::to_string),
        number,
    };
    assert_eq!(a("#12"), item(None, None, 12));
    assert_eq!(a("12"), item(None, None, 12));
    assert_eq!(a("pr#7"), item(Some(ItemKind::Pr), None, 7));
    assert_eq!(a("PR#7"), item(Some(ItemKind::Pr), None, 7));
    assert_eq!(a("issue#3"), item(Some(ItemKind::Issue), None, 3));
    assert_eq!(a("alice/proj#4"), item(None, Some("alice/proj"), 4));
    assert_eq!(
        a("https://forge.dashhq.org/repo/pull/?owner=alice&name=proj&number=9"),
        item(None, Some("alice/proj"), 9)
    );
    for bad in ["", "#", "pr#", "twelve", "#-1", "alice/proj", "#1.5"] {
        assert!(parse_item_arg(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn a_new_board_starts_from_its_template_with_the_columns_given() {
    let spec = spec_for(BoardTemplate::Kanban, HOME, None, 0).unwrap();
    assert_eq!(spec, default_spec(HOME, 0));
    let spec = spec_for(
        BoardTemplate::Kanban,
        HOME,
        Some(" Backlog, Doing ,Review,done "),
        0,
    )
    .unwrap();
    let names: Vec<&str> = spec.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["Backlog", "Doing", "Review", "done"]);
    assert_eq!((spec.def, spec.done), (1, 4));
    // the definition is one the rules accept, sources and views included
    assert!(forge_core::collab::boards::check_board_input("Sprint", &spec).is_ok());
    let empty = spec_for(BoardTemplate::Empty, HOME, Some("A,B"), 0).unwrap();
    assert!(empty.sources.is_empty() && empty.fields.is_empty());
    assert!(empty.views.is_empty());
    assert_eq!((empty.done, empty.arch), (0, 0));
    assert!(forge_core::collab::boards::check_board_input("Ideas", &empty).is_ok());
    // every template is a definition the board rules accept, as the web's create dialog writes it
    for t in [
        BoardTemplate::Kanban,
        BoardTemplate::Sprint,
        BoardTemplate::Triage,
        BoardTemplate::Empty,
    ] {
        let spec = spec_for(t, HOME, None, 1_800_000_000_000).unwrap();
        assert!(
            forge_core::collab::boards::check_board_input("Board", &spec).is_ok(),
            "{t:?}"
        );
    }
    let triage = spec_for(BoardTemplate::Triage, HOME, None, 0).unwrap();
    assert_eq!(triage.sources[0].q, "label:bug");
    assert_eq!((triage.def, triage.done), (1, 4));
    assert!(spec_for(BoardTemplate::Kanban, HOME, Some("A,,B"), 0).is_err());
    let many = vec!["c"; 21].join(",");
    assert!(spec_for(BoardTemplate::Kanban, HOME, Some(&many), 0).is_err());
}

#[test]
fn columns_and_fields_are_found_by_name_in_any_case() {
    let spec = default_spec(HOME, 0);
    assert_eq!(find_column(&spec, "in PROGRESS"), Some(2));
    assert_eq!(find_column(&spec, "3"), Some(3));
    // "No status" is a column only on a board whose default is none (def 0): elsewhere an item
    // without a column shows in the default column, so a move there is refused
    assert_eq!(find_column(&spec, "none"), None);
    let mut no_default = spec.clone();
    no_default.def = 0;
    assert_eq!(find_column(&no_default, "No Status"), Some(0));
    assert_eq!(find_column(&spec, "Later"), None);
    assert_eq!(find_field(&spec, "priority").map(|f| f.id), Some(1));
    assert_eq!(column_name(&spec, 0), "No status");
}

#[test]
fn field_values_are_typed_by_their_field() {
    let spec = default_spec(HOME, 0); // Iteration from 1969-12-29, 14 days
    let now = 20 * 86_400_000; // in its second iteration (index 1)
    let field = |name: &str| find_field(&spec, name).unwrap();
    let v = |name: &str, raw: &str| parse_value(field(name), raw, now);
    assert_eq!(v("Priority", "p1").unwrap(), Some(Scalar::from(2)));
    assert!(v("Priority", "P9").is_err());
    assert_eq!(v("Estimate", "2.5").unwrap(), Some(Scalar::Num(2.5)));
    assert!(v("Estimate", "lots").is_err());
    assert_eq!(v("Iteration", "@current").unwrap(), Some(Scalar::from(1)));
    assert_eq!(v("Iteration", "@next").unwrap(), Some(Scalar::from(2)));
    assert_eq!(v("Iteration", "@previous").unwrap(), Some(Scalar::from(0)));
    assert_eq!(
        v("Iteration", "Iteration 4").unwrap(),
        Some(Scalar::from(3))
    );
    assert_eq!(v("Iteration", "4").unwrap(), Some(Scalar::from(3)));
    assert!(v("Iteration", "0").is_err());
    assert_eq!(v("Estimate", " ").unwrap(), None, "an empty value clears");
    assert_eq!(value_text(field("Priority"), &Scalar::from(2)), "P1");
    assert_eq!(
        value_text(field("Iteration"), &Scalar::from(3)),
        "Iteration 4"
    );
    assert_eq!(value_text(field("Estimate"), &Scalar::Num(3.0)), "3");
}

#[test]
fn assignments_make_one_patch() {
    let spec = default_spec(HOME, 0);
    let patch = parse_assignments(
        &spec,
        &[
            "priority=P0".into(),
            "Estimate=".into(),
            "status=Done".into(),
        ],
        0,
    )
    .unwrap();
    assert_eq!(patch.col, Some(3));
    assert_eq!(patch.fields.get(&1), Some(&Some(Scalar::from(1))));
    assert_eq!(patch.fields.get(&2), Some(&None));
    assert!(parse_assignments(&spec, &["priority".into()], 0).is_err());
    assert!(parse_assignments(&spec, &["colour=red".into()], 0).is_err());
    assert!(parse_assignments(&spec, &["status=Later".into()], 0).is_err());
}

fn parse(args: &[&str]) -> Result<Cli, clap::Error> {
    Cli::try_parse_from(std::iter::once("dg").chain(args.iter().copied()))
}

#[test]
fn the_board_commands_parse_as_documented() {
    let cli = parse(&[
        "board",
        "move",
        "alice/proj",
        "7",
        "#12",
        "Done",
        "--before",
        "#3",
    ])
    .unwrap();
    let crate::Command::Board(BoardCommand::Move {
        item,
        column,
        before,
        top,
        ..
    }) = cli.command
    else {
        panic!("not a move");
    };
    assert_eq!(
        (item.as_str(), column.as_str(), before.as_deref(), top),
        ("#12", "Done", Some("#3"), false)
    );
    assert!(parse(&["board", "move", "a/p", "7", "#1", "Done", "--top", "--bottom"]).is_err());
    assert!(
        parse(&["board", "move", "a/p", "7", "#1", "Done", "--before", "#2", "--after", "#3"])
            .is_err()
    );
    assert!(
        parse(&["board", "set", "a/p", "7", "#1"]).is_err(),
        "set needs a value"
    );
    assert!(parse(&[
        "board",
        "set",
        "a/p",
        "7",
        "#1",
        "priority=P1",
        "estimate=3"
    ])
    .is_ok());
    assert!(
        parse(&["board", "add", "a/p", "7"]).is_err(),
        "add needs items or --title"
    );
    assert!(parse(&["board", "add", "a/p", "7", "--title", "Fix it"]).is_ok());
    assert!(parse(&["board", "add", "a/p", "7", "#1", "--title", "Fix it"]).is_err());
    assert!(parse(&["board", "add", "a/p", "7", "#1", "a/q#2", "--column", "Todo"]).is_ok());
    assert!(parse(&["board", "archive", "a/p", "7", "#1", "--restore"]).is_ok());
    assert!(parse(&["board", "remove", "a/p", "7"]).is_err());
    assert!(parse(&[
        "board",
        "create",
        "a/p",
        "--name",
        "Sprint",
        "--columns",
        "A,B",
        "--template",
        "empty"
    ])
    .is_ok());
    assert!(parse(&[
        "board",
        "create",
        "a/p",
        "--name",
        "Sprint",
        "--template",
        "kanban-ish"
    ])
    .is_err());
    for t in ["kanban", "sprint", "triage", "bugs", "empty"] {
        assert!(
            parse(&["board", "create", "a/p", "--name", "S", "--template", t]).is_ok(),
            "{t}"
        );
    }
    assert!(parse(&[
        "board",
        "view",
        "a/p",
        "Roadmap",
        "--view",
        "Table",
        "--archived"
    ])
    .is_ok());
    assert!(parse(&["board", "next-iteration", "a/p", "7", "--field", "Sprint"]).is_ok());
    assert!(parse(&["board", "close", "a/p", "7", "--reopen"]).is_ok());
    assert!(parse(&["board", "list", "a/p", "--deleted"]).is_ok());
}
