"""A simple singly linked list."""


class Node:
    """A single element in the linked list."""

    def __init__(self, value):
        self.value = value
        self.next = None


class LinkedList:
    """A singly linked list of values."""

    def __init__(self):
        self.head = None
        self.size = 0

    def is_empty(self):
        return self.head is None

    def append(self, value):
        """Add a value to the end of the list."""
        node = Node(value)
        if self.head is None:
            self.head = node
        else:
            current = self.head
            while current.next is not None:
                current = current.next
            current.next = node
        self.size += 1

    def prepend(self, value):
        """Add a value to the front of the list."""
        node = Node(value)
        node.next = self.head
        self.head = node
        self.size += 1

    def pop_front(self):
        """Remove and return the front value."""
        if self.head is None:
            return None
        value = self.head.value
        self.head = self.head.next
        self.size -= 1
        return value

    def remove(self, value):
        """Remove the first node whose value matches. Returns True if removed."""
        if self.head is None:
            return False
        if self.head.value == value:
            self.head = self.head.next
            self.size -= 1
            return True
        current = self.head
        while current.next is not None:
            if current.next.value == value:
                current.next = current.next.next
                self.size -= 1
                return True
            current = current.next
        return False

    def find(self, value):
        """Return True if any node holds the given value."""
        current = self.head
        while current is not None:
            if current.value == value:
                return True
            current = current.next
        return False

    def reverse(self):
        """Reverse the list in place and return it."""
        previous = None
        current = self.head
        while current is not None:
            nxt = current.next
            current.next = previous
            previous = current
            current = nxt
        self.head = previous
        return self

    def to_list(self):
        """Return the values as a Python list (for inspection)."""
        values = []
        current = self.head
        while current is not None:
            values.append(current.value)
            current = current.next
        return values

    def __len__(self):
        return self.size

    def __repr__(self):
        return f"LinkedList({self.to_list()})"
