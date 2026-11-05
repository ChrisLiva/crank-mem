$x = 1

# Gets a thing.
function Get-Thing {
    [CmdletBinding()]
    param([string]$Name)
    "thing $Name"
}

filter Only-Even {
    if ($_ % 2 -eq 0) { $_ }
}

workflow Run-Flow {
    "flow"
}

class Box {
    [int]$Size = 1

    Box([int]$size) {
        $this.Size = $size
    }

    [int] Area() {
        return $this.Size * $this.Size
    }
}

enum Color {
    Red
    Green
}
