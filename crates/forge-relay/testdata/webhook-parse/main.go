// Parses relay payloads with go-github's webhook parser, as a Go consumer would (D-605).
//
// Usage: go run . <dir>. Each file in <dir> is named <X-GitHub-Event>.<n>.json. It exits
// non-zero if any payload fails to parse, or if an id comes back 0 (absent).
//
// Run by forge-relay's `payloads_parse_with_go_github` test when `go` is on PATH.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/go-github/v66/github"
)

func main() {
	files, err := filepath.Glob(filepath.Join(os.Args[1], "*.json"))
	if err != nil || len(files) == 0 {
		fmt.Println("no payloads found")
		os.Exit(2)
	}
	failed := false
	for _, f := range files {
		event := strings.SplitN(filepath.Base(f), ".", 2)[0]
		body, err := os.ReadFile(f)
		if err != nil {
			panic(err)
		}
		parsed, err := github.ParseWebHook(event, body)
		if err != nil {
			fmt.Printf("%s: PARSE ERROR: %v\n", filepath.Base(f), err)
			failed = true
			continue
		}
		if msg := check(parsed); msg != "" {
			fmt.Printf("%s: %s\n", filepath.Base(f), msg)
			failed = true
			continue
		}
		fmt.Printf("%s: ok\n", filepath.Base(f))
	}
	if failed {
		os.Exit(1)
	}
}

// check returns what is missing: every object's id must have decoded to a non-zero int64.
func check(e interface{}) string {
	switch e := e.(type) {
	case *github.PushEvent:
		return ids("repository", e.GetRepo().GetID(), "sender", e.GetSender().GetID())
	case *github.IssuesEvent:
		return ids("repository", e.GetRepo().GetID(), "issue", e.GetIssue().GetID(), "sender", e.GetSender().GetID())
	case *github.IssueCommentEvent:
		return ids("repository", e.GetRepo().GetID(), "issue", e.GetIssue().GetID(), "comment", e.GetComment().GetID())
	case *github.PullRequestEvent:
		return ids("repository", e.GetRepo().GetID(), "pull_request", e.GetPullRequest().GetID())
	case *github.PullRequestReviewEvent:
		return ids("repository", e.GetRepo().GetID(), "review", e.GetReview().GetID(), "pull_request", e.GetPullRequest().GetID())
	case *github.ReleaseEvent:
		return ids("repository", e.GetRepo().GetID(), "release", e.GetRelease().GetID())
	case *github.CheckRunEvent:
		return ids("repository", e.GetRepo().GetID(), "check_run", e.GetCheckRun().GetID())
	default:
		return fmt.Sprintf("unexpected event type %T", e)
	}
}

func ids(pairs ...interface{}) string {
	for i := 0; i < len(pairs); i += 2 {
		if pairs[i+1].(int64) == 0 {
			return fmt.Sprintf("%s.id is missing", pairs[i])
		}
	}
	return ""
}
