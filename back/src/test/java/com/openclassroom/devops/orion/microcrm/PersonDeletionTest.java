package com.openclassroom.devops.orion.microcrm;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.boot.test.autoconfigure.orm.jpa.TestEntityManager;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

@DataJpaTest
class PersonDeletionTest {

    @Autowired
    private TestEntityManager entityManager;

    @Autowired
    private PersonRepository personRepository;

    @Test
    void whenDeletingPersonWithNoOrganization_thenDoesNotThrow() {
        Person jdoe = new Person("John", "Doe", "jdoe@example.net");
        entityManager.persist(jdoe);
        entityManager.flush();

        assertDoesNotThrow(() -> {
            personRepository.delete(jdoe);
            entityManager.flush();
        });
    }
}
