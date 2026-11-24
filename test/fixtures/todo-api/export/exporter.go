package export

import (
	"fmt"
	"strings"
)

// Todo is the exported shape of a todo item.
type Todo struct {
	ID    string
	Title string
	Done  bool
}

// ExportCSV renders todos as CSV with an id,title,done header row.
func ExportCSV(todos []Todo) string {
	var b strings.Builder
	b.WriteString("id,title,done\n")
	for _, t := range todos {
		b.WriteString(fmt.Sprintf("%s,%s,%t\n", t.ID, escape(t.Title), t.Done))
	}
	return b.String()
}

func escape(s string) string {
	if strings.ContainsAny(s, ",\"\n") {
		return "\"" + strings.ReplaceAll(s, "\"", "\"\"") + "\""
	}
	return s
}
